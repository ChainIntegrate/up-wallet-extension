// The toolbar button opens the test page in a tab (WebAuthn needs a visible, focused page).
const api = typeof browser !== "undefined" ? browser : chrome;
api.action.onClicked.addListener(() => api.tabs.create({ url: api.runtime.getURL("test.html") }));
