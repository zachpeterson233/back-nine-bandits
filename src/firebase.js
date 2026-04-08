import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyC15ZwtkY_92zKAeCAklnnO9LT02PH0Zkw",
  authDomain: "back-nine-bandits.firebaseapp.com",
  projectId: "back-nine-bandits",
  storageBucket: "back-nine-bandits.firebasestorage.app",
  messagingSenderId: "29031824719",
  appId: "1:29031824719:web:083c7b41abbdde6c6d193a"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);