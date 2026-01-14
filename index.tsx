
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';

console.log("Murshid AI: Initializing entry point...");

const rootElement = document.getElementById('root');
if (!rootElement) {
  console.error("Murshid AI: Could not find root element to mount to");
  throw new Error("Could not find root element to mount to");
}

try {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
  console.log("Murshid AI: App mounted successfully");
} catch (error) {
  console.error("Murshid AI: Critical mount error:", error);
}
