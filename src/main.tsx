import { createRouter, RouterProvider } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import { ThemeProvider as NextThemeProvider, useTheme } from "next-themes";
import { StrictMode, useEffect } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import "@openuidev/react-ui/components.css";

// Import the generated route tree
import { routeTree } from "./routeTree.gen";

// Create a new router instance
const router = createRouter({ routeTree });

// Register the router instance for type safety
declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

// Cross-window theme sync. The command palette lives in its own Tauri
// window, so flipping the theme there only mutates that window's DOM.
// WKWebView doesn't fire cross-window `storage` events, so next-themes
// can't self-sync between windows either. Instead the palette broadcasts
// an `aizuchi:set-theme` event and this listener — mounted in every window
// via `main.tsx` — applies it, keeping meeting/note/recording windows and
// the shared localStorage value in step. Renders nothing.
function ThemeSync() {
	const { setTheme } = useTheme();
	useEffect(() => {
		const unlisten = listen<"light" | "dark">("aizuchi:set-theme", (event) => {
			setTheme(event.payload);
		});
		return () => {
			unlisten.then((fn) => fn()).catch(() => {});
		};
	}, [setTheme]);
	return null;
}

// Render the app
const rootElement = document.getElementById("root");
if (rootElement && !rootElement.innerHTML) {
	const root = ReactDOM.createRoot(rootElement);
	root.render(
		<StrictMode>
			<NextThemeProvider
				attribute="class"
				defaultTheme="light"
				enableSystem={false}
				disableTransitionOnChange
			>
				<ThemeSync />
				<RouterProvider router={router} />
			</NextThemeProvider>
		</StrictMode>,
	);
}
