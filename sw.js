// Clicking the toolbar button opens the console in a tab.
// If it is already open somewhere, focus that tab instead of opening a second
// one — a second console cannot have the serial port anyway.
const CONSOLE_URL = chrome.runtime.getURL("console.html");

chrome.action.onClicked.addListener(async () => {
  const existing = await chrome.tabs.query({ url: CONSOLE_URL });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: CONSOLE_URL });
  }
});
