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
  // --- New states for DLP demonstration ---
  const [originalText, setOriginalText] = useState('');
  const [deidentifiedText, setDeidentifiedText] = useState('');


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
      setOriginalText(''); // Clear DLP demo
      setDeidentifiedText(''); // Clear DLP demo
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
    setOriginalText(''); // Clear DLP demo
    setDeidentifiedText(''); // Clear DLP demo
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
    setDeidentifiedText('');

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
      setSummary(data.summary);
      setOriginalText(data.original_text); // Set original text from backend
      setDeidentifiedText(data.deidentified_text); // Set de-identified text from backend
      console.log('Summary and DLP data received from backend.');

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
          
          {/* NEW: Display original and de-identified text for DLP demo */}
          {(originalText || deidentifiedText) && (
            <div className="dlp-demo-output">
              <h2>DLP Demonstration:</h2>
              <div style={{display: 'flex', gap: '20px', textAlign: 'left'}}>
                <div style={{flex: 1, border: '1px solid #ddd', padding: '10px', borderRadius: '5px'}}>
                  <h3>Original Text Sent to DLP:</h3>
                  <p style={{whiteSpace: 'pre-wrap', maxHeight: '300px', overflowY: 'auto', fontSize: '0.8em'}}>{originalText}</p>
                </div>
                <div style={{flex: 1, border: '1px solid #ddd', padding: '10px', borderRadius: '5px'}}>
                  <h3>De-identified Text Sent to LLM:</h3>
                  <p style={{whiteSpace: 'pre-wrap', maxHeight: '300px', overflowY: 'auto', fontSize: '0.8em'}}>{deidentifiedText}</p>
                </div>
              </div>
            </div>
          )}

          {summary && (
            <div className="summary-output">
              <h2>Summary (from De-identified Text):</h2>
              <p>{summary}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;