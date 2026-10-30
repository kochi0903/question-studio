import { createApp } from "../server/app.js";

// Vercel invokes this Express app for /api/* while serving Vite's dist folder
// as static assets from the same deployment.
export default createApp();
