import os
import firebase_admin
from firebase_admin import credentials, auth
from flask import Flask, request, jsonify
from flask_cors import CORS
from google.cloud import aiplatform, storage, dlp_v2 as dlp
import vertexai
from vertexai.preview.generative_models import GenerativeModel, Part
import pypdf
from functools import wraps
import google.auth
from google.auth import impersonated_credentials

# --- Firebase Admin SDK Initialization ---
try:
    firebase_admin.initialize_app(credentials.ApplicationDefault())
    print("Firebase Admin SDK initialized successfully.")
except Exception as e:
    print(f"Error initializing Firebase Admin SDK: {e}")
    exit(1)

app = Flask(__name__)
CORS(app) 

# --- Cloud Run Environment Configuration ---
GCP_PROJECT_ID = os.environ.get("GCP_PROJECT_ID")
GCP_PROJECT_REGION = os.environ.get("GCP_PROJECT_REGION")
PDF_BUCKET_NAME = "pdf-summarizer-pdfs-gcp-security-experiment" 
PDF_BUCKET_LOCATION = "southamerica-west1" 

# --- Vertex AI Initialization ---
try:
    if not GCP_PROJECT_ID or not GCP_PROJECT_REGION:
        raise ValueError("GCP_PROJECT_ID or GCP_PROJECT_REGION environment variables not set.")
        
    vertexai.init(project=GCP_PROJECT_ID, location=GCP_PROJECT_REGION)
    print(f"Vertex AI initialized for project {GCP_PROJECT_ID} in region {GCP_PROJECT_REGION}")
except Exception as e:
    print(f"Error initializing Vertex AI: {e}")
    print("Please ensure GCP_PROJECT_ID and GCP_PROJECT_REGION are correctly set as environment variables before running the application.")
    exit(1)

model = GenerativeModel("gemini-2.0-flash-001")

# --- Initialize Google Cloud Storage client with impersonated credentials for signing ---
try:
    source_credentials, project_id = google.auth.default()
    target_credentials = impersonated_credentials.Credentials(
        source_credentials=source_credentials,
        target_principal="pdf-summarizer-sa@gcp-security-experiment.iam.gserviceaccount.com",
        target_scopes=['https://www.googleapis.com/auth/cloud-platform']
    )
    storage_client = storage.Client(credentials=target_credentials, project=project_id)
    print("Google Cloud Storage client initialized with impersonated credentials for signing.")
except Exception as e:
    print(f"Error initializing Google Cloud Storage client for signing: {e}")
    print("Please ensure the service account has roles/iam.serviceAccountTokenCreator (on itself!) and appropriate storage roles.")
    exit(1)

# --- Initialize Google Cloud DLP client ---
dlp_client = dlp.DlpServiceClient()
# IMPORTANT: Adjust DLP processing location if you changed it in the last step
#dlp_parent = f"projects/{GCP_PROJECT_ID}/locations/us-central1"
dlp_parent = f"projects/{GCP_PROJECT_ID}/locations/southamerica-west1"
print(f"Google Cloud DLP client initialized for parent: {dlp_parent}")

# --- Authentication Decorator (The "Bouncer") ---
def verify_firebase_token(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if request.method == 'OPTIONS':
            return f(*args, **kwargs)

        id_token = request.headers.get('Authorization')
        if not id_token:
            return jsonify({"error": "Authorization header missing. Please log in."}), 401

        if 'Bearer ' in id_token:
            id_token = id_token.split('Bearer ')[1]
        
        try:
            decoded_token = auth.verify_id_token(id_token)
            request.user_id = decoded_token['uid']
            request.user_email = decoded_token.get('email', 'N/A')
            
        except Exception as e:
            print(f"Token verification failed: {e}")
            return jsonify({"error": f"Unauthorized: Invalid or expired token. {str(e)}"}), 401
        
        return f(*args, **kwargs)
    return decorated_function

# --- PDF Text Extraction Function ---
def extract_text_from_pdf(pdf_file_stream):
    reader = pypdf.PdfReader(pdf_file_stream)
    text = ""
    for page in reader.pages:
        text += page.extract_text() or ""
    return text

# --- NEW: Get Signed URL API Endpoint ---
@app.route('/get-signed-url', methods=['POST', 'OPTIONS'])
@verify_firebase_token
def get_signed_url():
    if request.method == 'OPTIONS':
        return '', 204

    print(f"Signed URL request from user: {request.user_email} (UID: {request.user_id})")

    file_name = request.json.get('fileName')
    content_type = request.json.get('contentType')

    if not file_name or not content_type:
        return jsonify({"error": "fileName and contentType are required"}), 400

    object_name = f"{request.user_id}/{os.urandom(16).hex()}_{file_name}"

    try:
        bucket = storage_client.bucket(PDF_BUCKET_NAME)
        blob = bucket.blob(object_name)

        signed_url = blob.generate_signed_url(
            version="v4",
            expiration=900,  # 15 minutes
            method="PUT",
            content_type=content_type,
        )
        return jsonify({"signedUrl": signed_url, "objectName": object_name})

    except Exception as e:
        print(f"Error generating signed URL: {e}")
        return jsonify({"error": f"Failed to generate signed URL: {str(e)}"}), 500

# --- MODIFIED: Summarize PDF API Endpoint (reads from GCS and uses DLP) ---
@app.route('/summarize-pdf', methods=['POST', 'OPTIONS'])
@verify_firebase_token
def summarize_pdf():
    if request.method == 'OPTIONS':
        return '', 204

    object_name = request.json.get('objectName') 

    if not object_name:
        return jsonify({"error": "objectName is required in the request body"}), 400

    if not object_name.startswith(f"{request.user_id}/"):
        return jsonify({"error": "Access denied to this object."}), 403

    try:
        bucket = storage_client.bucket(PDF_BUCKET_NAME)
        blob = bucket.blob(object_name)

        if not blob.exists():
            return jsonify({"error": "PDF file not found in storage."}), 404

        pdf_file_stream = blob.open("rb")

        pdf_text = extract_text_from_pdf(pdf_file_stream)

        pdf_file_stream.close()

        if not pdf_text.strip():
            return jsonify({"error": "Could not extract text from PDF or PDF is empty."}), 400

        # --- DLP Integration ---
        dlp_item = {"value": pdf_text}
        
        # Define info types for both INSPECTION and DE-IDENTIFICATION
        all_relevant_info_types = [
            {"name": "EMAIL_ADDRESS"},
            {"name": "PHONE_NUMBER"},
            {"name": "CREDIT_CARD_NUMBER"},
            {"name": "PERSON_NAME"},
            {"name": "DATE_OF_BIRTH"},
            {"name": "LOCATION"},
            # {"name": "SSN"}, # Removed due to regional availability
            {"name": "IBAN_CODE"},
            {"name": "SWIFT_CODE"},
            {"name": "CHILE_CDI_NUMBER"},
            # {"name": "ACCOUNT_NUMBER"}, # Removed due to regional availability
        ]
        
        # New: Define the InspectConfig. This tells DLP what to look for.
        inspect_config = {
            "info_types": all_relevant_info_types,
            "include_quote": True,
        }

        # Redaction configuration: replace with info type name (e.g., [PHONE_NUMBER])
        redact_config = {
            "info_type_transformations": {
                "transformations": [
                    {
                        "info_types": all_relevant_info_types,
                        "primitive_transformation": {"replace_with_info_type_config": {}}
                    }
                ]
            }
        }
        
        # Build the de-identification request
        dlp_request = {
            "parent": dlp_parent,
            "item": dlp_item,
            "deidentify_config": redact_config,
            "inspect_config": inspect_config,
        }
        
        print("Sending text to DLP for de-identification...")
        dlp_response = dlp_client.deidentify_content(request=dlp_request)
        deidentified_text = dlp_response.item.value
        print("Received de-identified text from DLP.")
        # --- End DLP Integration ---

        # Prepare the prompt for Gemini with de-identified text
        prompt = f"Summarize this document in 200 words:\n\n{deidentified_text}"

        print("Sending de-identified text to Gemini...")
        response = model.generate_content(
            prompt,
            generation_config={"max_output_tokens": 200, "temperature": 0.2}
        )

        summary = response.text
        print("Received summary from Gemini.")
        
        # MODIFIED: Return original_text and deidentified_text too
        return jsonify({
            "summary": summary,
            "original_text": pdf_text,
            "deidentified_text": deidentified_text
        })

    except Exception as e:
        print(f"An error occurred during summarization (GCS read or DLP): {e}")
        return jsonify({"error": f"An error occurred during processing: {str(e)}"}), 500

@app.route('/', methods=['GET'])
def health_check():
    return "Backend is running!"

if __name__ == '__main__':
    app.run(debug=True, port=5000)