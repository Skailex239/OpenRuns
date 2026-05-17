import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  GithubAuthProvider,
  OAuthProvider,
  signOut, 
  onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { 
  getFirestore, 
  doc, 
  getDoc, 
  setDoc 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = { 
  apiKey: "AIzaSyCaJnNR5WOKY9tHg6X9IWpcQcBKHJpvTrk", 
  authDomain: "openfront-speedrun.firebaseapp.com", 
  projectId: "openfront-speedrun", 
  storageBucket: "openfront-speedrun.firebasestorage.app", 
  messagingSenderId: "710681441859", 
  appId: "1:710681441859:web:a01003e5b07c83ea50c6f6", 
  measurementId: "G-SD1GNCN8NV" 
}; 

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Providers
const googleProvider = new GoogleAuthProvider();
const discordProvider = new OAuthProvider('oidc.discord');

export { auth, db, doc, getDoc, setDoc, googleProvider, discordProvider, signInWithPopup, signOut, onAuthStateChanged };

window.loginWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error) {
    console.error("Erreur Google Login:", error);
    let msg = "Erreur lors de la connexion Google";
    if (error.code === 'auth/unauthorized-domain') {
      msg += "\n\nDomaine non autorisé. Veuillez ajouter 'skailex239.github.io' dans la console Firebase (Authentification > Paramètres > Domaines autorisés).";
    } else if (error.code === 'auth/operation-not-allowed') {
      msg += "\n\nLa connexion Google n'est pas activée dans votre console Firebase.";
    } else {
      msg += ": " + (error.message || error.code);
    }
    alert(msg);
  }
};

window.loginWithDiscord = async () => {
  try {
    const provider = new OAuthProvider('discord.com'); 
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (error) {
    console.error("Erreur Discord Login:", error);
    let msg = "Erreur lors de la connexion Discord";
    if (error.code === 'auth/unauthorized-domain') {
      msg += "\n\nDomaine non autorisé dans la console Firebase.";
    } else if (error.code === 'auth/operation-not-allowed') {
      msg += "\n\nLa connexion via ce fournisseur n'est pas activée.";
    } else {
      msg += ": " + (error.message || error.code);
    }
    alert(msg + "\n\nVérifiez la configuration (Client ID / Secret) dans Firebase.");
  }
};

window.logout = () => signOut(auth);
