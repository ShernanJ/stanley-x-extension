export default defineBackground(() => {
  console.log('[Stanley-X] Background service worker started');

  browser.runtime.onInstalled.addListener(() => {
    console.log('[Stanley-X] Background installed');
  });
});
