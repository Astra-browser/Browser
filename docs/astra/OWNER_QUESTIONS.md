# Owner questions (P0-T10) — blocking items, do not guess

1. **Logo/artwork:** final logo, icons (SVG/PNG/`icns`/`ico`), any brand fonts? (blocks release builds; dev uses PLACEHOLDER)
2. **App ID + domains:** reverse-DNS `app_id`, homepage, docs/support URLs? (blocks release builds)
3. **Update host:** hostname for MAR manifests + signing setup? (blocks updater E2E)
4. **Signing certificates:** Windows Authenticode, Apple Developer ID, Linux deb repo key? (blocks installers)
5. **Crash-report policy:** opt-in self-hosted, or diagnostics-bundle-only? (P1-T02/P8 decision)
6. **Password/autofill:** keep Firefox login-manager surfaces or rely on password-manager extensions? (P4-T09)
7. **Golden thresholds:** accept initial ≤ 1.5% per-screen pixel diff? (P3-T11)
8. **Sync crypto review:** who performs the external review before Phase 7 release? (P7-T01 gate)
9. **Public distribution:** confirm 72 h security-SLA automation is proven before any public release (R-02)?
