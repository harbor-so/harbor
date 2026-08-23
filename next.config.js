/** @type {import("next").NextConfig} */
const config = {
	// Packages that must be `require`d at runtime rather than bundled by webpack.
	//
	// `postgres` opens real sockets. The two vendor SDKs are here for a sharper
	// reason: `app/sandbox/registry.ts` imports every provider eagerly — that is what
	// makes a missing `switch` case a compile error — so both SDKs are reachable from
	// the Next.js server graph even on a deployment that will never use them. Each
	// resolves modules by computed expression (`modal` → `@grpc/grpc-js` and
	// `protobufjs`; `@codesandbox/sdk` → `blessed`'s widget loader), which webpack
	// cannot follow. Their imports are also deferred to first use inside the
	// providers themselves; this list is what keeps the bundler's hands off them.
	serverExternalPackages: ["postgres", "modal", "@codesandbox/sdk"],

	webpack: (config) => {
		// The source imports with explicit `.js` extensions because that is what
		// Node's ESM resolver requires at runtime — `tsx` runs the MCP server and
		// the migration scripts directly, with no bundler in the path. TypeScript
		// understands that `./work.js` means `./work.ts`; webpack does not, and
		// would otherwise force the whole codebase to choose between being
		// bundler-correct and being runtime-correct.
		config.resolve.extensionAlias = {
			".js": [".ts", ".tsx", ".js"],
			".jsx": [".tsx", ".jsx"],
		};
		return config;
	},
};

export default config;
