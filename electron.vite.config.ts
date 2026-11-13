import { resolve } from "node:path";
import net from "node:net";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

// Windows (Hyper-V / WSL) reserves shifting blocks of TCP ports, and Vite's
// default 5173 is often inside one: listening there fails with EACCES, which
// Vite doesn't retry. So pick a port that can actually be bound right now.
function canListen(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const srv = net.createServer();
    srv.once("error", () => ok(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => ok(true)));
  });
}

async function freePort(candidates: number[]): Promise<number> {
  for (const p of candidates) if (await canListen(p)) return p;
  return 0; // let the OS choose
}

// main + preload are bundled for Node (Electron), the renderer is a React
// app served by Vite in dev (with Fast Refresh) and built to out/renderer.
export default defineConfig(async () => ({
  main: {
    resolve: { alias: { "@shared": resolve("src/shared") } },
  },
  preload: {
    resolve: { alias: { "@shared": resolve("src/shared") } },
  },
  renderer: {
    resolve: { alias: { "@shared": resolve("src/shared"), "@": resolve("src/renderer/src") } },
    plugins: [react()],
    server: { host: "127.0.0.1", port: await freePort([15173, 25173, 35173, 45173]), strictPort: true },
  },
}));
