export default function App() {
  return (
    <main
      style={{
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif',
        maxWidth: 640,
        margin: "10vh auto",
        padding: "0 24px",
        lineHeight: 1.5,
      }}
    >
      <h1 data-edit-id="react.title" style={{ fontSize: "2.25rem" }}>
        Built with React, edited without code
      </h1>
      <p data-edit-id="react.subtitle" style={{ fontSize: "1.1rem", opacity: 0.7 }}>
        data-edit-id is just a plain HTML attribute, so it passes straight
        through JSX unchanged.
      </p>
      <p data-edit-id="react.body">
        No editbar-specific React component or hook is used on this page —
        the same widget script that runs on the vanilla HTML demo runs here
        too.
      </p>
      <p style={{ marginTop: 48, fontSize: "0.85rem", opacity: 0.7 }}>
        Open this page with <code>?edit_token=dev-token</code> appended to
        the URL to try the admin bar (make sure the reference server is
        running on port 4000).
      </p>
    </main>
  );
}
