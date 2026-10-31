// climb for Claude Code: an MCP stdio server hosting the extension the omp/pi hosts load (src/).
//
// Claude Code starts this server once per session. It speaks MCP and hands every tool call and hook to a
// host (claude/host.ts): the session's climb. When Claude Code installs a newer climb, the next call loads
// that version's host and swaps it in while no climb tool is running: an update needs no restart. Hooks
// (hooks/hooks.json) and this file itself still load at session start.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHost, type Host, VERSION } from "./host";

const send = (msg: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

/** The climb this server runs: the plugin root it was started from, then each update's. */
const real = (p: string) => {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
};
let root = real(path.resolve(import.meta.dir, ".."));
const REGISTRY = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "plugins", "installed_plugins.json");
/** The climb Claude Code has installed now, when it is another version beside this one (a --plugin-dir checkout has none). */
function installed(): string | undefined {
	try {
		const r = JSON.parse(fs.readFileSync(REGISTRY, "utf8")) as { plugins?: Record<string, { installPath?: string }[]> };
		for (const [name, entries] of Object.entries(r.plugins ?? {}))
			for (const e of name.startsWith("climb@") ? entries : [])
				if (e.installPath && real(e.installPath) !== root && path.dirname(real(e.installPath)) === path.dirname(root) && fs.existsSync(path.join(e.installPath, "claude", "host.ts"))) return real(e.installPath);
	} catch {}
	return undefined;
}

let host: Host | undefined;
let ready: Promise<void> | undefined;
let swapping: Promise<void> | undefined;
let checked = 0;
const CHECK_MS = Number(process.env.CLIMB_UPDATE_CHECK_MS) || 10_000;
/** An installed update swaps in between tool calls; one that fails to load leaves the running climb as it is. */
function update(): Promise<void> | undefined {
	if (swapping || !host || host.busy() || Date.now() - checked < CHECK_MS) return swapping;
	checked = Date.now();
	const next = installed();
	if (!next) return undefined;
	const old = host;
	swapping = (async () => {
		try {
			const mod = (await import(path.join(next, "claude", "host.ts"))) as typeof import("./host");
			const carry = old.handoff();
			await old.stop();
			try {
				host = await mod.createHost({ send }, carry, old.version);
				root = next;
			} catch (e) {
				host = await createHost({ send }, carry); // the new code would not start: keep climbing on this one
				console.error("climb: the update failed to start; still on", old.version, e);
			}
			send({ method: "notifications/tools/list_changed" });
		} catch (e) {
			console.error("climb: the update failed to load; still on", old.version, e);
			checked = Date.now() + 10 * 60_000;
		} finally {
			swapping = undefined;
		}
	})();
	return swapping;
}

const VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
async function dispatch(m: { id?: string | number; method?: string; params?: Record<string, unknown> }) {
	try {
		if (m.method === "tools/call" || m.method === "tools/list") await update();
		switch (m.method) {
			case "initialize": {
				// omp also discovers plugins installed in Claude Code: under any other client this server stays
				// empty, or two climbs (omp's extension and this one) would drive one ledger.
				if ((m.params?.clientInfo as { name?: string } | undefined)?.name === "claude-code")
					ready ??= createHost({ send }).then(h => {
						host = h;
					});
				const asked = m.params?.protocolVersion as string;
				return send({ id: m.id, result: { protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS.at(-1), capabilities: { tools: { listChanged: true } }, serverInfo: { name: "climb", version: VERSION } } });
			}
			case "ping":
				return send({ id: m.id, result: {} });
			case "tools/list":
				if (!ready) return send({ id: m.id, result: { tools: [] } });
				await ready;
				return send({ id: m.id, result: { tools: host!.list() } });
			case "tools/call":
				if (!ready) return send({ id: m.id, result: { content: [{ type: "text", text: "{}" }] } });
				await ready;
				return send({ id: m.id, result: await host!.call(m.id!, m.params as never) });
			case "notifications/cancelled":
				return host?.cancel(m.params?.requestId as string);
		}
		if (m.id !== undefined && m.method) send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
	} catch (e) {
		if (m.id !== undefined) send({ id: m.id, error: { code: -32603, message: String(e) } });
	}
}

let buf = "";
process.stdin.on("data", d => {
	buf += d;
	for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (!line) continue;
		try {
			void dispatch(JSON.parse(line));
		} catch {
			send({ id: null, error: { code: -32700, message: "Parse error" } });
		}
	}
});
process.stdin.on("end", () => process.exit(0));
