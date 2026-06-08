// Ally capture content script (self-contained classic script — no ES imports;
// content scripts can't use module imports). Filled in Task 1.3. For now it just
// announces itself so the manifest loads and the content script is present.
console.log('[ally-checks] capture content script loaded on', location.host);
