const path = require('node:path');

// Keep the profile location stable when the product display name changes.
function libraryDataDirectory(appData, override) {
  if (override) return path.resolve(override);
  return appData ? path.resolve(appData, 'Nine Model Library') : null;
}

module.exports = { libraryDataDirectory };
