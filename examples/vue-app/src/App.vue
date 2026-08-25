<template>
  <main class="page">
    <h1 data-edit-id="vue.title">Built with Vue, edited without code</h1>
    <p data-edit-id="vue.subtitle">
      data-edit-id is just a plain HTML attribute in the template, so it
      passes straight through Vue's compiler unchanged.
    </p>
    <p data-edit-id="vue.body">
      No editbar-specific Vue component or directive is used on this page —
      the same widget script that runs on the vanilla HTML and React demos
      runs here too.
    </p>
    <p class="note">
      Visit <a href="http://localhost:4000/setup">localhost:4000/setup</a> for
      your admin token and the exact link to open this page as an admin
      (make sure the reference server is running on port 4000) — the token
      is generated fresh per server, so there's no fixed one to hardcode.
    </p>
  </main>
</template>

<style scoped>
.page {
  font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
  max-width: 640px;
  margin: 10vh auto;
  padding: 0 24px;
  line-height: 1.5;
}
h1 {
  font-size: 2.25rem;
}
.note {
  margin-top: 48px;
  font-size: 0.85rem;
  opacity: 0.7;
}
</style>
