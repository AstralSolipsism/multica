import deployment from "./origin.json";

// Defaults for this deployment. App-layer environment/config overrides still
// take precedence; core must not read process.env or browser storage.
export const DEPLOYMENT_URL = deployment.origin;
export const DEPLOYMENT_WS_URL = `${DEPLOYMENT_URL.replace(/^https:/, "wss:")}/ws`;
export const DOWNLOAD_PAGE_URL = `${DEPLOYMENT_URL}/download`;
export const DOWNLOAD_BASE_URL = `${DEPLOYMENT_URL}/downloads`;
export const LATEST_MANIFEST_URL = `${DOWNLOAD_BASE_URL}/latest.json`;
export const CLI_INSTALL_SH_URL = `${DOWNLOAD_BASE_URL}/install.sh`;
export const CLI_INSTALL_PS1_URL = `${DOWNLOAD_BASE_URL}/install.ps1`;
