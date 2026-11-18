// Runs on any Node version (keep syntax ES2015-safe) so old installs get a clear message.
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(`StreamNest needs Node.js 24 or newer (found ${process.versions.node}).`);
  console.error("Windows: winget install OpenJS.NodeJS.LTS   (or: nvm install 24 && nvm use 24)");
  console.error("Linux / Raspberry Pi: nvm install 24, or https://github.com/nodesource/distributions");
  process.exit(1);
}
