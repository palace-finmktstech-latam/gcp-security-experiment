// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBH8YOA3jGUrSsIBJQeXNleHcIoVU81P1s",
  authDomain: "gcp-security-experiment.firebaseapp.com",
  projectId: "gcp-security-experiment",
  storageBucket: "gcp-security-experiment.firebasestorage.app",
  messagingSenderId: "459042076639",
  appId: "1:459042076639:web:d78e63c15a8d03654db66a"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firebase Authentication and get a reference to the service
export const auth = getAuth(app);

export default app;
