import { describe, expect, it } from "vitest";
import { oauthErrorHtml, oauthSuccessHtml } from "../src/utils/oauth-page.ts";

describe("OAuth callback pages", () => {
	it("renders success without the upstream logo", () => {
		const html = oauthSuccessHtml("ChatGPT authentication completed. You can close this window.");
		expect(html).toContain("<h1>Authentication successful</h1>");
		expect(html).toContain("ChatGPT authentication completed. You can close this window.");
		expect(html).not.toContain("<svg");
		expect(html).not.toContain('class="logo"');
	});

	it("renders errors without the upstream logo and escapes provider content", () => {
		const html = oauthErrorHtml("Failed <script>", 'Details & "reason"');
		expect(html).toContain("<h1>Authentication failed</h1>");
		expect(html).toContain("Failed &lt;script&gt;");
		expect(html).toContain("Details &amp; &quot;reason&quot;");
		expect(html).not.toContain("<svg");
		expect(html).not.toContain('class="logo"');
	});
});
