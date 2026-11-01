<script>
  const build = "P1-T08 overlay bundle";
</script>

<main class="astra-shell-hello">
  <div class="badge">chrome://astra/ resolves — overlay P1-T05</div>
  <h1>Hello Tab</h1>
  <p>The Astra shell is mounted in the browser window. ({build})</p>
</main>

<style>
  .astra-shell-hello {
    font-family: system-ui, sans-serif;
    display: grid;
    place-items: center;
    min-height: 100vh;
    margin: 0;
    background: #1c1b22;
    color: #fbfbfe;
    text-align: center;
  }
  .astra-shell-hello .badge {
    display: inline-block;
    padding: 0.25rem 0.75rem;
    border: 1px solid #52525e;
    border-radius: 999px;
    font-size: 0.8rem;
    color: #cfcfd8;
  }
</style>
