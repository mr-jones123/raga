#!/usr/bin/env node
/**
 * Build a self-contained artifact from an HTML source: render Mermaid blocks to SVG with Pele,
 * highlight code, inline local images, check the layout, then print to PDF with headless Chrome.
 *
 *   node artifact.mjs build <source.html> [--out <dir>] [--no-pdf] [--preview]
 *
 * Prints one JSON object. Exit 1 lists every problem instead of producing a partial artifact.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Pele and highlight.js are pinned dependencies of raga. Resolve them from this file first, which works
 * for the bundled copy inside the raga package, then from the installed raga executable, which works
 * for a copy in an instance revision.
 */
function packageRequires() {
	const roots = [import.meta.url];
	if (process.env.RAGA_PACKAGE_DIR) roots.push(pathToFileURL(join(process.env.RAGA_PACKAGE_DIR, "package.json")).href);
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const raga = join(directory, "raga");
		if (!existsSync(raga)) continue;
		roots.push(pathToFileURL(realpathSync(raga)).href);
	}
	return roots.map((root) => createRequire(root));
}

function resolveDependency(name) {
	for (const require of packageRequires()) {
		try {
			return require.resolve(name);
		} catch {}
	}
	throw new Error(`Cannot find ${name}. Run the skill from a raga installation, or set RAGA_PACKAGE_DIR to the raga package directory.`);
}

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp" };
const ENTITIES = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&amp;": "&" };
const decode = (text) => text.replace(/&(?:lt|gt|quot|#39|apos|nbsp|amp);/g, (entity) => ENTITIES[entity]);

function chromePath() {
	const candidates = [
		process.env.CHROME_PATH,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	];
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
			candidates.push(join(directory, name));
		}
	}
	return candidates.find((path) => path && existsSync(path));
}

/** Run headless Chrome on a local file with a throwaway profile, so it never touches the user's browser. */
function runChrome(chrome, htmlPath, outputPath, extraArgs) {
	return chromeProcess(chrome, htmlPath, extraArgs).then(() => {
		if (!existsSync(outputPath)) throw new Error(`Chrome did not write ${outputPath}`);
	});
}

/** Run headless Chrome and return its standard output. */
function runChromeOutput(chrome, htmlPath, extraArgs) {
	return chromeProcess(chrome, htmlPath, extraArgs);
}

function chromeProcess(chrome, htmlPath, extraArgs) {
	const profile = mkdtempSync(join(tmpdir(), "raga-artifact-chrome-"));
	const args = [
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		// Without these, macOS Chrome asks the login keychain for "Chrome Safe Storage" even in a throwaway profile.
		"--use-mock-keychain",
		"--password-store=basic",
		"--disable-sync",
		"--disable-background-networking",
		`--user-data-dir=${profile}`,
		"--virtual-time-budget=5000",
		...extraArgs,
		pathToFileURL(htmlPath).href,
	];
	const { promise, resolve: done, reject } = Promise.withResolvers();
	const child = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		if (stdout.length < 20_000_000) stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		if (stderr.length < 20000) stderr += chunk;
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
	child.once("error", reject);
	child.once("close", (code) => {
		clearTimeout(timer);
		rmSync(profile, { recursive: true, force: true });
		if (code === 0) done(stdout);
		else reject(new Error(`Chrome failed (exit ${code}). ${stderr.trim().slice(-2000)}`));
	});
	return promise;
}

/** Measure layout in Chrome: a slide whose content leaves its frame, or a wide block in a document. */
async function checkLayout(chrome, htmlPath) {
	const probe = `<script>addEventListener("load", () => {
		const issues = [];
		document.querySelectorAll("section.slide").forEach((slide, index) => {
			const frame = slide.getBoundingClientRect();
			let bottom = 0, right = 0;
			for (const el of slide.querySelectorAll("*")) {
				if (el.closest(".footer")) continue;
				const rect = el.getBoundingClientRect();
				if (!rect.width || !rect.height) continue;
				bottom = Math.max(bottom, rect.bottom - frame.top);
				right = Math.max(right, rect.right - frame.left);
			}
			const over = Math.round(Math.max(bottom - frame.height, right - frame.width, slide.scrollHeight - slide.clientHeight));
			if (over > 1) issues.push("Slide " + (index + 1) + " overflows its frame by " + over + "px. Cut content or split the slide.");
		});
		document.querySelectorAll("main pre, main table, main figure, main img").forEach((el) => {
			const over = el.scrollWidth - el.clientWidth;
			if (over > 1) issues.push("A " + el.tagName.toLowerCase() + " is " + over + "px wider than the page. Shorten lines or narrow it.");
		});
		const out = document.createElement("pre");
		out.id = "raga-layout";
		out.textContent = JSON.stringify(issues);
		document.body.append(out);
	});</script>`;
	const directory = mkdtempSync(join(tmpdir(), "raga-artifact-layout-"));
	try {
		const probePath = join(directory, "probe.html");
		writeFileSync(probePath, readFileSync(htmlPath, "utf8").replace(/<\/body>/i, `${probe}</body>`));
		const dom = await runChromeOutput(chrome, probePath, ["--window-size=1680,1000", "--dump-dom"]);
		const match = /<pre id="raga-layout">([\s\S]*?)<\/pre>/.exec(dom);
		return match ? JSON.parse(decode(match[1])) : ["The layout check did not finish."];
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Page count from the PDF's page tree. Chrome writes it uncompressed. */
function pdfPages(pdfPath) {
	const text = readFileSync(pdfPath).toString("latin1");
	const counts = [...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)].map((match) => Number(match[1]));
	return counts.length ? Math.max(...counts) : undefined;
}

async function build(sourcePath, options) {
	const source = readFileSync(sourcePath, "utf8");
	const directory = dirname(sourcePath);
	const problems = [];
	const warnings = [];
	if (/<script\b/i.test(source)) problems.push("Remove <script> elements. Artifacts are static so they print and share safely.");
	if (/<(?:iframe|object|embed)\b/i.test(source)) problems.push("Remove <iframe>, <object>, and <embed> elements.");
	if (/<link\b[^>]*href\s*=\s*["']https?:/i.test(source) || /url\(\s*["']?https?:/i.test(source))
		problems.push("Remove remote stylesheets, fonts, and background images. The artifact must work offline.");

	const { render, PeleError } = await import(pathToFileURL(resolveDependency("pele")).href);
	const hljs = createRequire(import.meta.url)(resolveDependency("highlight.js"));
	const font = /--font-sans\s*:\s*([^;]+);/.exec(source)?.[1]?.trim() ?? "sans-serif";

	let diagrams = 0;
	let html = source.replace(/<pre\b([^>]*\bclass\s*=\s*["'][^"']*\bmermaid\b[^"']*["'][^>]*)>([\s\S]*?)<\/pre>/gi, (_whole, _attrs, body) => {
		diagrams++;
		try {
			return `<figure class="diagram">${render(decode(body).trim(), { fontFamily: font }).svg}</figure>`;
		} catch (error) {
			if (!(error instanceof PeleError)) throw error;
			problems.push(`Diagram ${diagrams}: ${error.message}`);
			return "";
		}
	});

	let codeBlocks = 0;
	html = html.replace(/<pre>\s*<code\b[^>]*\bclass\s*=\s*["'][^"']*\blanguage-([\w+-]+)[^"']*["'][^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (whole, language, body) => {
		if (!hljs.getLanguage(language)) {
			warnings.push(`Code block language "${language}" is unknown; left unhighlighted.`);
			return whole;
		}
		codeBlocks++;
		return `<pre class="code"><code class="hljs language-${language}">${hljs.highlight(decode(body), { language, ignoreIllegals: true }).value}</code></pre>`;
	});

	let images = 0;
	html = html.replace(/(<img\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (whole, prefix, quote, src) => {
		if (src.startsWith("data:")) return whole;
		if (/^[a-z][a-z0-9+.-]*:/i.test(src)) {
			problems.push(`Image ${src} is remote. Download it next to the source and use a relative path.`);
			return whole;
		}
		const file = resolve(directory, decode(src));
		const mime = MIME[extname(file).toLowerCase()];
		if (!mime || !existsSync(file) || !statSync(file).isFile()) {
			problems.push(`Image ${src} is missing or not a PNG, JPEG, GIF, SVG, or WebP file.`);
			return whole;
		}
		images++;
		return `${prefix}${quote}data:${mime};base64,${readFileSync(file).toString("base64")}${quote}`;
	});

	const slides = (html.match(/<section\b[^>]*\bclass\s*=\s*["'][^"']*\bslide\b/gi) ?? []).length;
	if (problems.length) return { ok: false, problems, warnings };

	const outDir = resolve(options.out ?? join(directory, "dist"));
	mkdirSync(outDir, { recursive: true });
	const name = basename(sourcePath).replace(/\.html?$/i, "");
	const htmlPath = join(outDir, `${name}.html`);
	writeFileSync(htmlPath, html);
	const result = { ok: true, html: htmlPath, diagrams, codeBlocks, images, slides, warnings };
	if (!options.pdf && !options.preview) return result;
	const chrome = chromePath();
	if (!chrome) return { ...result, ok: false, problems: ["No Chrome, Chromium, Edge, or Brave found. Install one or set CHROME_PATH."] };
	result.layout = await checkLayout(chrome, htmlPath);
	if (options.preview) {
		// Screen layout: slides stack 900px frames with 40px gaps inside 40px padding; a document gets its first pages.
		const size = slides ? `1680,${slides * 940 + 80}` : "900,3600";
		const previewPath = join(outDir, `${name}.png`);
		rmSync(previewPath, { force: true });
		await runChrome(chrome, htmlPath, previewPath, ["--hide-scrollbars", `--window-size=${size}`, `--screenshot=${previewPath}`]);
		result.preview = previewPath;
	}
	if (!options.pdf) return result;
	const pdfPath = join(outDir, `${name}.pdf`);
	rmSync(pdfPath, { force: true });
	await runChrome(chrome, htmlPath, pdfPath, ["--no-pdf-header-footer", "--print-to-pdf-no-header", `--print-to-pdf=${pdfPath}`]);
	const pages = pdfPages(pdfPath);
	if (slides && pages !== undefined && pages !== slides)
		warnings.push(`The PDF has ${pages} pages for ${slides} slides. A slide overflows its page; shorten it or split it.`);
	return { ...result, pdf: pdfPath, pages };
}

const [command, sourceArg, ...rest] = process.argv.slice(2);
if (command !== "build" || !sourceArg) {
	console.error("Usage: node artifact.mjs build <source.html> [--out <dir>] [--no-pdf] [--preview]");
	process.exit(2);
}
const outIndex = rest.indexOf("--out");
try {
	const result = await build(resolve(sourceArg), {
		out: outIndex >= 0 ? rest[outIndex + 1] : undefined,
		pdf: !rest.includes("--no-pdf"),
		preview: rest.includes("--preview"),
	});
	console.log(JSON.stringify(result, null, 2));
	process.exit(result.ok ? 0 : 1);
} catch (error) {
	console.log(JSON.stringify({ ok: false, problems: [error instanceof Error ? error.message : String(error)], warnings: [] }, null, 2));
	process.exit(1);
}
