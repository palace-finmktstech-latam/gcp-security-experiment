import React, { useState, useEffect } from 'react';
import './App.css';
import { auth } from './firebaseConfig';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from 'firebase/auth';

function App() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [summary, setSummary] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // --- Auth-related states ---
  const [user, setUser] = useState(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');

  // --- New state for Cloud Storage object name ---
  const [cloudStorageObjectName, setCloudStorageObjectName] = useState('');
  // --- States for DLP/Pseudonymization demonstration ---
  const [originalText, setOriginalText] = useState('');
  const [pseudonymizedText, setPseudonymizedText] = useState(''); // This is the text sent to DLP
  const [deidentifiedText, setDeidentifiedText] = useState(''); // This is the text sent to LLM
  const [llmOutputPseudonymized, setLlmOutputPseudonymized] = useState(''); // New state for raw LLM output
  const [finalSummary, setFinalSummary] = useState(''); // This will hold summary with real names


  // IMPORTANT: Replace with the actual URL of your deployed Cloud Run service
  const CLOUD_RUN_URL = 'https://pdf-summarizer-backend-459042076639.us-central1.run.app';

  // --- Authentication State Listener ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoadingAuth(false);
    });
    return () => unsubscribe();
  }, []);

  // --- Auth Handlers ---
  const handleSignUp = async (e) => {
    e.preventDefault();
    setAuthError('');
    try {
      await createUserWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setAuthError(err.message);
      console.error("Sign up error:", err);
    }
  };

  const handleSignIn = async (e) => {
    e.preventDefault();
    setAuthError('');
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setAuthError(err.message);
      console.error("Sign in error:", err);
    }
  };

  const handleSignOut = async () => {
    setAuthError('');
    try {
      await signOut(auth);
      setSummary('');
      setSelectedFile(null);
      setCloudStorageObjectName('');
      setOriginalText('');
      setPseudonymizedText('');
      setDeidentifiedText('');
      setLlmOutputPseudonymized(''); // Clear new state
      setFinalSummary('');
    } catch (err) {
      setAuthError(err.message);
      console.error("Sign out error:", err);
    }
  };

  // --- File and Summary Handlers ---
  const handleFileChange = (event) => {
    setSelectedFile(event.target.files[0]);
    setSummary('');
    setError('');
    setCloudStorageObjectName('');
    setOriginalText('');
    setPseudonymizedText('');
    setDeidentifiedText('');
    setLlmOutputPseudonymized(''); // Clear new state
    setFinalSummary('');
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!selectedFile) {
      setError('Please select a PDF file first.');
      return;
    }
    if (!user) {
      setError('You must be logged in to summarize a PDF.');
      return;
    }

    setLoading(true);
    setError('');
    setSummary('');
    setCloudStorageObjectName('');
    setOriginalText('');
    setPseudonymizedText('');
    setDeidentifiedText('');
    setLlmOutputPseudonymized('');
    setFinalSummary('');

    try {
      const idToken = await user.getIdToken();

      // --- STEP 1: Get Signed URL from Backend ---
      console.log('Requesting signed URL from backend...');
      const signedUrlResponse = await fetch(`${CLOUD_RUN_URL}/get-signed-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          fileName: selectedFile.name,
          contentType: selectedFile.type
        })
      });

      if (!signedUrlResponse.ok) {
        const errorData = await signedUrlResponse.json();
        throw new Error(errorData.error || `HTTP error getting signed URL! status: ${signedUrlResponse.status}`);
      }
      const { signedUrl, objectName } = await signedUrlResponse.json();
      console.log('Received signed URL and object name:', objectName);
      setCloudStorageObjectName(objectName);

      // --- STEP 2: Directly Upload PDF to Google Cloud Storage using Signed URL ---
      console.log('Uploading PDF directly to Cloud Storage...');
      const uploadResponse = await fetch(signedUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': selectedFile.type,
        },
        body: selectedFile,
      });

      if (!uploadResponse.ok) {
        throw new Error(`HTTP error uploading to GCS! status: ${uploadResponse.status}`);
      }
      console.log('PDF uploaded successfully to Cloud Storage.');

      // --- STEP 3: Tell Backend to Summarize PDF from Cloud Storage ---
      console.log('Requesting summary from backend using objectName...');
      const summarizeResponse = await fetch(`${CLOUD_RUN_URL}/summarize-pdf`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({ objectName: objectName })
      });

      if (!summarizeResponse.ok) {
        const errorData = await summarizeResponse.json();
        throw new Error(errorData.error || `HTTP error summarizing! status: ${summarizeResponse.status}`);
      }

      const data = await summarizeResponse.json();
      setSummary(data.summary); // Final summary with real names
      setOriginalText(data.original_text);
      setPseudonymizedText(data.pseudonymized_text); // Text sent to DLP (with pseudonyms)
      setDeidentifiedText(data.deidentified_text); // Text sent to LLM (after DLP)
      setLlmOutputPseudonymized(data.llm_output_pseudonymized); // Raw LLM output (with pseudonyms)
      setFinalSummary(data.summary); // This will hold the re-identified summary
      console.log('Summary and DLP/Pseudonymization data received from backend.');

    } catch (err) {
      console.error('Full process error:', err);
      setError(`Failed to get summary: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // --- Render Logic ---
  if (loadingAuth) {
    return <div className="App">Loading authentication...</div>;
  }

  return (
    <div className="App">
      <h1>PDF Summarizer</h1>

      {!user ? (
        <div className="auth-container">
          <h2>Sign Up / Sign In</h2>
          <form onSubmit={handleSignIn}>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <div className="auth-buttons">
              <button type="submit">Sign In</button>
              <button type="button" onClick={handleSignUp}>Sign Up</button>
            </div>
            {authError && <p style={{ color: 'red' }}>Auth Error: {authError}</p>}
          </form>
        </div>
      ) : (
        <div className="app-content">
          <div className="user-info">
            <p>Logged in as: {user.email}</p>
            <button onClick={handleSignOut}>Sign Out</button>
          </div>

          <form onSubmit={handleSubmit}>
            <input
              type="file"
              accept=".pdf"
              onChange={handleFileChange}
              disabled={loading}
            />
            <button type="submit" disabled={!selectedFile || loading}>
              {loading ? 'Processing...' : 'Summarize PDF'}
            </button>
          </form>

          {error && <p style={{ color: 'red' }}>Error: {error}</p>}

          {cloudStorageObjectName && !loading && (
            <p>Uploaded as: {cloudStorageObjectName}</p>
          )}
          
          {/* NEW: Display original, pseudonymized, de-identified, and final summary */}
          {(originalText || pseudonymizedText || deidentifiedText || llmOutputPseudonymized || finalSummary) && (
            <div className="dlp-demo-output">
              <h2>Data Transformation Pipeline:</h2>
              <div className="dlp-text-containers" style={{gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))'}}>
                <div className="dlp-text-container">
                  <h3>Original Text (from PDF):</h3>
                  <p>{originalText}</p>
                </div>
                <div className="dlp-text-container">
                  <h3>Pseudonymized/De-identified Text (Sent to LLM):</h3>
                  <p>{pseudonymizedText}</p>
                </div>
                <div className="dlp-text-container">
                  <h3>Raw LLM Output (Contains Pseudonyms):</h3>
                  <p>{llmOutputPseudonymized}</p>
                </div>
                <div className="dlp-text-container">
                  <h3>Final Summary (Re-identified):</h3>
                  <p>{finalSummary}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;