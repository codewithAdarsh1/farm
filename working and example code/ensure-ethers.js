/**
 * Lazy-load ethers v5.7.2 only when a wallet action needs it.
 * Does NOT call eth_requestAccounts / connect — script load only.
 */
(function (global) {
  var loading = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () {
        resolve();
      };
      s.onerror = function () {
        reject(new Error('Failed to load ' + src));
      };
      document.head.appendChild(s);
    });
  }

  /**
   * @returns {Promise<typeof ethers>}
   */
  global.ensureEthers = function ensureEthers() {
    if (global.ethers && global.ethers.providers) {
      return Promise.resolve(global.ethers);
    }
    if (loading) return loading;

    loading = loadScript('/vendor/ethers.umd.min.js')
      .catch(function () {
        return loadScript('https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.umd.min.js');
      })
      .then(function () {
        if (!global.ethers || !global.ethers.providers) {
          throw new Error('ethers failed to initialize');
        }
        return global.ethers;
      })
      .catch(function (err) {
        loading = null;
        throw err;
      });

    return loading;
  };
})(typeof window !== 'undefined' ? window : this);
