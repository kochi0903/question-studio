import { createApp } from "./app.js";
const port = Number(process.env.PORT || 4174);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer between 1 and 65535.");
const server = createApp().listen(port, "127.0.0.1", () =>
  console.log(`Question Studio server listening at http://127.0.0.1:${port}`),
);
server.on("error", (error) => {
  console.error("Server could not start:", error.message);
  process.exitCode = 1;
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
