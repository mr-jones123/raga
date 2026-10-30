export default {
	branches: ["main"],
	repositoryUrl: "https://github.com/mr-jones123/raga.git",
	tagFormat: "raga-v${version}",
	plugins: [
		["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
		["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
		["@semantic-release/changelog", { changelogFile: "CHANGELOG.md" }],
		[
			"@semantic-release/git",
			{
				assets: ["CHANGELOG.md"],
				message: "chore(release): raga v${nextRelease.version} [skip ci]",
			},
		],
		[
			"@semantic-release/github",
			{
				successCommentCondition: false,
				failCommentCondition: false,
				failTitle: false,
				labels: false,
				releasedLabels: false,
			},
		],
	],
};
