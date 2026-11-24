// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
    str::FromStr,
    sync::Arc,
    time::Duration,
};

use base64::Engine;
use futures_util::StreamExt;
use http::{HeaderName, header::ACCEPT};
use minisign_verify::{PublicKey, Signature};
use percent_encoding::{AsciiSet, CONTROLS};
use reqwest::{
    ClientBuilder, StatusCode,
    header::{HeaderMap, HeaderValue},
};
use semver::Version;
use serde::{Deserialize, Deserializer, Serialize, de::Error as DeError};
#[cfg(any(windows, target_os = "linux"))]
use std::ffi::OsStr;
use tauri::{
    AppHandle, Resource, Runtime,
    utils::{
        config::BundleType,
        platform::{bundle_type, current_exe},
    },
};
use time::OffsetDateTime;
use url::Url;

use crate::{
    Config,
    error::{Error, Result},
};

const UPDATER_USER_AGENT: &str = concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"),);

/// The kind of bundle the running application was installed from.
///
/// Its name is appended to the updater target string (`{os}-{arch}-{bundle_type}`) when looking
/// up the release in the update manifest and replaces the `{{bundle_type}}` variable in the
/// endpoint URLs.
#[derive(Copy, Clone)]
pub enum Installer {
    /// Linux AppImage bundle, named `appimage`.
    AppImage,
    /// Debian package, named `deb`.
    Deb,
    /// RPM package, named `rpm`.
    Rpm,

    /// macOS application bundle, named `app`. Also used for applications distributed as DMG.
    App,

    /// Windows WiX (MSI) installer, named `msi`.
    Msi,
    /// Windows NSIS installer, named `nsis`.
    Nsis,
}

impl Installer {
    fn name(self) -> &'static str {
        match self {
            Self::AppImage => "appimage",
            Self::Deb => "deb",
            Self::Rpm => "rpm",
            Self::App => "app",
            Self::Msi => "msi",
            Self::Nsis => "nsis",
        }
    }
}

/// The update information of a single platform in the update manifest.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ReleaseManifestPlatform {
    /// Download URL for the platform
    pub url: Url,
    /// Signature for the platform
    pub signature: String,
}

/// The platform specific data of a [`RemoteRelease`], in either of the two supported shapes.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(untagged)]
pub enum RemoteReleaseInner {
    /// Server Format: the endpoint resolved the platform itself and returned a single
    /// download URL and signature.
    Dynamic(ReleaseManifestPlatform),
    /// Static Format: the manifest describes every platform it supports and the updater
    /// picks the entry matching the current target.
    Static {
        /// Update information for each platform, keyed by the updater target string
        /// (e.g. `darwin-aarch64`).
        platforms: HashMap<String, ReleaseManifestPlatform>,
    },
}

/// Information about a release returned by the remote update server.
///
/// This type can have one of two shapes: Server Format (Dynamic Format) and Static Format.
#[derive(Debug, Clone)]
pub struct RemoteRelease {
    /// Version to install.
    pub version: Version,
    /// Release notes.
    pub notes: Option<String>,
    /// Release date.
    pub pub_date: Option<OffsetDateTime>,
    /// Release data.
    pub data: RemoteReleaseInner,
}

impl RemoteRelease {
    /// The release's download URL for the given target.
    pub fn download_url(&self, target: &str) -> Result<&Url> {
        match self.data {
            RemoteReleaseInner::Dynamic(ref platform) => Ok(&platform.url),
            RemoteReleaseInner::Static { ref platforms } => platforms
                .get(target)
                .map_or(Err(Error::TargetNotFound(target.to_string())), |p| {
                    Ok(&p.url)
                }),
        }
    }

    /// The release's signature for the given target.
    pub fn signature(&self, target: &str) -> Result<&String> {
        match self.data {
            RemoteReleaseInner::Dynamic(ref platform) => Ok(&platform.signature),
            RemoteReleaseInner::Static { ref platforms } => platforms
                .get(target)
                .map_or(Err(Error::TargetNotFound(target.to_string())), |platform| {
                    Ok(&platform.signature)
                }),
        }
    }
}

/// Function executed right before the Windows installer is spawned and the app exits.
/// See [`UpdaterBuilder::on_before_exit`].
pub type OnBeforeExit = Arc<dyn Fn() + Send + Sync + 'static>;
/// Function that customizes the `reqwest` client builder used for the updater requests.
/// See [`UpdaterBuilder::configure_client`].
pub type OnBeforeRequest = Arc<dyn Fn(ClientBuilder) -> ClientBuilder + Send + Sync + 'static>;
/// Function that decides whether a remote release must be installed.
///
/// It receives the current application version and the remote release,
/// and returns `true` when the release should be treated as an update.
pub type VersionComparator = Arc<dyn Fn(Version, RemoteRelease) -> bool + Send + Sync>;
#[cfg(target_os = "macos")]
type MainThreadClosure = Box<dyn FnOnce() + Send + Sync + 'static>;
#[cfg(target_os = "macos")]
type RunOnMainThread = Arc<dyn Fn(MainThreadClosure) -> tauri::Result<()> + Send + Sync + 'static>;

// TODO: Move more fields to this in v3 if we can mark those fields non `pub`
/// Updater context shared between [`UpdaterBuilder`], [`Updater`] and [`Update`]
#[derive(Clone)]
struct UpdaterContext {
    config: Config,
    configure_client: Option<OnBeforeRequest>,
    #[cfg(target_os = "macos")]
    run_on_main_thread: RunOnMainThread,
    /// App name, used for creating named tempfiles
    #[cfg(windows)]
    app_name: String,
    #[cfg(windows)]
    installer_args: Vec<OsString>,
    #[cfg(windows)]
    current_exe_args: Vec<OsString>,
    #[cfg(windows)]
    on_before_exit: Option<OnBeforeExit>,
    #[cfg(windows)]
    restart_after_install: bool,
}

/// Builder for an [`Updater`] instance.
///
/// Get one from [`crate::UpdaterExt::updater_builder`], which pre-fills it with the plugin
/// configuration, then call [`UpdaterBuilder::build`].
pub struct UpdaterBuilder {
    current_version: Version,
    pub(crate) version_comparator: Option<VersionComparator>,
    executable_path: Option<PathBuf>,
    target: Option<String>,
    endpoints: Option<Vec<Url>>,
    headers: HeaderMap,
    timeout: Option<Duration>,
    proxy: Option<Url>,
    no_proxy: bool,
    context: UpdaterContext,
}

impl UpdaterBuilder {
    pub(crate) fn new<R: Runtime>(app: &AppHandle<R>, config: crate::Config) -> Self {
        #[cfg(target_os = "macos")]
        let run_on_main_thread = {
            let app_ = app.clone();
            Arc::new(move |f| app_.run_on_main_thread(f))
        };
        Self {
            context: UpdaterContext {
                #[cfg(windows)]
                installer_args: config
                    .windows
                    .as_ref()
                    .map(|w| w.installer_args.clone())
                    .unwrap_or_default(),
                config,
                configure_client: None,
                #[cfg(target_os = "macos")]
                run_on_main_thread,
                #[cfg(windows)]
                app_name: app.package_info().name.clone(),
                #[cfg(windows)]
                current_exe_args: Vec::new(),
                #[cfg(windows)]
                on_before_exit: None,
                #[cfg(windows)]
                restart_after_install: true,
            },
            current_version: app.package_info().version.clone(),
            version_comparator: None,
            executable_path: None,
            target: None,
            endpoints: None,
            headers: Default::default(),
            timeout: None,
            proxy: None,
            no_proxy: false,
        }
    }

    /// Sets the function used to decide whether the remote release must be installed,
    /// replacing the comparator set with [`crate::Builder::default_version_comparator`]
    /// and the behavior of the `allowDowngrades` configuration value.
    ///
    /// When no comparator is set, a release is only installed if its version is greater
    /// than the current application version.
    pub fn version_comparator<F: Fn(Version, RemoteRelease) -> bool + Send + Sync + 'static>(
        mut self,
        f: F,
    ) -> Self {
        self.version_comparator = Some(Arc::new(f));
        self
    }

    /// Sets the target name used when checking for updates.
    ///
    /// It replaces the `{{target}}` variable in the endpoint URLs and is used as the key to look
    /// up the release in the `platforms` object of a static update manifest.
    ///
    /// When it is not set, the updater uses the current operating system name (`linux`, `darwin`
    /// or `windows`) in the endpoint URLs and looks for `{os}-{arch}-{bundle_type}` then
    /// `{os}-{arch}` in the manifest.
    pub fn target(mut self, target: impl Into<String>) -> Self {
        self.target.replace(target.into());
        self
    }

    /// Sets the endpoints to fetch the update manifest from,
    /// overriding the `endpoints` configuration value.
    ///
    /// They are checked in order and the first one that returns a valid release wins.
    ///
    /// # Errors
    ///
    /// Returns [`Error::InsecureTransportProtocol`] on release builds if an endpoint does not use
    /// the `https` protocol and the `dangerousInsecureTransportProtocol` configuration value is
    /// not enabled. On debug builds a warning is printed instead.
    pub fn endpoints(mut self, endpoints: Vec<Url>) -> Result<Self> {
        crate::config::validate_endpoints(
            &endpoints,
            self.context.config.dangerous_insecure_transport_protocol,
        )?;

        self.endpoints.replace(endpoints);
        Ok(self)
    }

    /// Sets the path of the application executable, which is used to determine where the update
    /// must be installed. Defaults to the path of the current executable, or to the AppImage path
    /// when the application runs as an AppImage.
    pub fn executable_path<P: AsRef<Path>>(mut self, p: P) -> Self {
        self.executable_path.replace(p.as_ref().into());
        self
    }

    /// Adds a header to be sent on the update check and download requests.
    ///
    /// # Errors
    ///
    /// Returns an error if the header name or the header value is not valid.
    pub fn header<K, V>(mut self, key: K, value: V) -> Result<Self>
    where
        HeaderName: TryFrom<K>,
        <HeaderName as TryFrom<K>>::Error: Into<http::Error>,
        HeaderValue: TryFrom<V>,
        <HeaderValue as TryFrom<V>>::Error: Into<http::Error>,
    {
        let key: std::result::Result<HeaderName, http::Error> = key.try_into().map_err(Into::into);
        let value: std::result::Result<HeaderValue, http::Error> =
            value.try_into().map_err(Into::into);
        self.headers.insert(key?, value?);

        Ok(self)
    }

    /// Replaces all the headers sent on the update check and download requests with the given map,
    /// discarding the ones previously added with [`Self::header`].
    pub fn headers(mut self, headers: HeaderMap) -> Self {
        self.headers = headers;
        self
    }

    /// Removes all the headers previously set on this builder.
    pub fn clear_headers(mut self) -> Self {
        self.headers.clear();
        self
    }

    /// Sets the timeout of the update check and download requests.
    /// When it is not set, the requests do not time out.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// Sets the proxy used for the update check and download requests.
    /// It is ignored when [`Self::no_proxy`] was called.
    pub fn proxy(mut self, proxy: Url) -> Self {
        self.proxy.replace(proxy);
        self
    }

    /// Clear all proxies. See [`reqwest::ClientBuilder::no_proxy`](https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html#method.no_proxy).
    pub fn no_proxy(mut self) -> Self {
        self.no_proxy = true;
        self
    }

    /// Sets the public key used to verify the update signature,
    /// overriding the `pubkey` value of the plugin configuration.
    pub fn pubkey<S: Into<String>>(mut self, pubkey: S) -> Self {
        self.context.config.pubkey = pubkey.into();
        self
    }

    /// Adds an argument to pass to the Windows installer.
    ///
    /// Note: this applies to both WiX and NSIS installers
    #[cfg_attr(not(windows), allow(unused))]
    pub fn installer_arg<S>(mut self, arg: S) -> Self
    where
        S: Into<OsString>,
    {
        #[cfg(windows)]
        {
            self.context.installer_args.push(arg.into());
        }
        self
    }

    /// Adds multiple arguments to pass to the Windows installer.
    ///
    /// Note: this applies to both WiX and NSIS installers
    #[cfg_attr(not(windows), allow(unused))]
    pub fn installer_args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        #[cfg(windows)]
        {
            self.context
                .installer_args
                .extend(args.into_iter().map(Into::into));
        }
        self
    }

    /// Removes all the additional arguments to pass to the Windows installer.
    ///
    /// Note: this only removes the additional arguments added through
    /// [`Self::installer_arg`], [`crate::Builder::installer_arg`]
    /// and the `plugins > updater > windows > installerArgs` config,
    /// not the ones managed by us (e.g. `/UPDATER` flag passed to the NSIS installer)
    #[cfg_attr(not(windows), allow(unused))]
    pub fn clear_installer_args(mut self) -> Self {
        #[cfg(windows)]
        {
            self.context.installer_args.clear();
        }
        self
    }

    /// Function to run before we run the installer and exit the app through `std::process::exit(0)` on Windows
    #[cfg_attr(not(windows), allow(unused))]
    pub fn on_before_exit<F: Fn() + Send + Sync + 'static>(mut self, f: F) -> Self {
        #[cfg(windows)]
        {
            self.context.on_before_exit.replace(Arc::new(f));
        }
        self
    }

    /// If the Windows installer should restart the app after installed, default is `true`
    #[cfg_attr(not(windows), allow(unused))]
    pub fn restart_after_install(mut self, restart_after_install: bool) -> Self {
        #[cfg(windows)]
        {
            self.context.restart_after_install = restart_after_install;
        }
        self
    }

    /// Allows you to modify the `reqwest` client builder before the HTTP request is sent.
    ///
    /// Note that `reqwest` crate may be updated in minor releases of tauri-plugin-updater.
    /// Therefore it's recommended to pin the plugin to at least a minor version when you're using `configure_client`.
    pub fn configure_client<F: Fn(ClientBuilder) -> ClientBuilder + Send + Sync + 'static>(
        mut self,
        f: F,
    ) -> Self {
        self.context.configure_client.replace(Arc::new(f));
        self
    }

    /// Builds the [`Updater`].
    ///
    /// # Errors
    ///
    /// - [`Error::EmptyEndpoints`]: neither [`Self::endpoints`] nor the `endpoints`
    ///   configuration value provided an endpoint to check.
    /// - [`Error::UnsupportedArch`]: the updater does not support the current architecture.
    /// - [`Error::FailedToDetermineExtractPath`]: the install directory could not be resolved
    ///   from the executable path.
    pub fn build(self) -> Result<Updater> {
        let endpoints = self
            .endpoints
            .unwrap_or_else(|| self.context.config.endpoints.clone());

        if endpoints.is_empty() {
            return Err(Error::EmptyEndpoints);
        };

        let arch = updater_arch().ok_or(Error::UnsupportedArch)?;

        let executable_path = self.executable_path.clone().unwrap_or(current_exe()?);

        // Get the extract_path from the provided executable_path
        let extract_path = if cfg!(target_os = "linux") {
            executable_path
        } else {
            extract_path_from_executable(&executable_path)?
        };

        Ok(Updater {
            current_version: self.current_version,
            version_comparator: self.version_comparator,
            timeout: self.timeout,
            proxy: self.proxy,
            no_proxy: self.no_proxy,
            endpoints,
            arch,
            target: self.target,
            headers: self.headers,
            extract_path,
            context: self.context.clone(),
        })
    }
}

#[cfg(windows)]
impl UpdaterBuilder {
    pub(crate) fn current_exe_args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.context
            .current_exe_args
            .extend(args.into_iter().map(Into::into));
        self
    }
}

/// Checks the configured endpoints for an application update.
///
/// Get one from [`crate::UpdaterExt::updater`] or by calling [`UpdaterBuilder::build`].
pub struct Updater {
    current_version: Version,
    version_comparator: Option<VersionComparator>,
    timeout: Option<Duration>,
    proxy: Option<Url>,
    no_proxy: bool,
    endpoints: Vec<Url>,
    arch: &'static str,
    // The `{{target}}` variable we replace in the endpoint and serach for in the JSON,
    // this is either the user provided target or the current operating system by default
    target: Option<String>,
    headers: HeaderMap,
    extract_path: PathBuf,
    context: UpdaterContext,
}

impl Updater {
    /// Checks the endpoints for an update, returning the first release that the version
    /// comparator accepts.
    ///
    /// Each endpoint is requested in order, with the `{{current_version}}`, `{{target}}`,
    /// `{{arch}}` and `{{bundle_type}}` variables replaced in its URL, until one of them
    /// answers with a release manifest the updater can parse.
    ///
    /// Resolves to `None` when an endpoint replies with `204 No Content` or when the release it
    /// announced is not considered an update - by default when its version is not greater than the
    /// current application version.
    ///
    /// # Errors
    ///
    /// - [`Error::UnsupportedOs`]: no target was set and the updater does not support the
    ///   current operating system.
    /// - [`Error::ReleaseNotFound`]: no endpoint returned a release manifest.
    /// - The last request or deserialization error when every endpoint failed.
    /// - [`Error::TargetNotFound`] or [`Error::TargetsNotFound`]: the manifest has no entry
    ///   for the current target.
    pub async fn check(&self) -> Result<Option<Update>> {
        // we want JSON only
        let mut headers = self.headers.clone();
        if !headers.contains_key(ACCEPT) {
            headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        }

        let target = self.current_target()?;

        let mut remote_release: Option<RemoteRelease> = None;
        let mut raw_json: Option<serde_json::Value> = None;
        let mut last_error: Option<Error> = None;
        for url in &self.endpoints {
            // replace {{current_version}}, {{target}}, {{arch}} and {{bundle_type}} in the provided URL
            // this is useful if we need to query example
            // https://releases.myapp.com/update/{{target}}/{{arch}}/{{current_version}}
            // will be translated into ->
            // https://releases.myapp.com/update/darwin/aarch64/1.0.0
            // The main objective is if the update URL is defined via the Cargo.toml
            // the URL will be generated dynamically
            let version = self.current_version.to_string();
            let version = version.as_bytes();
            const CONTROLS_ADD: &AsciiSet = &CONTROLS.add(b'+');
            let encoded_version = percent_encoding::percent_encode(version, CONTROLS_ADD);
            let encoded_version = encoded_version.to_string();
            let installer = installer_for_bundle_type(bundle_type())
                .map(|i| i.name())
                .unwrap_or("unknown");

            let url: Url = url
                .to_string()
                // url::Url automatically url-encodes the path components
                .replace("%7B%7Bcurrent_version%7D%7D", &encoded_version)
                .replace("%7B%7Btarget%7D%7D", target)
                .replace("%7B%7Barch%7D%7D", self.arch)
                .replace("%7B%7Bbundle_type%7D%7D", installer)
                // but not query parameters
                .replace("{{current_version}}", &encoded_version)
                .replace("{{target}}", target)
                .replace("{{arch}}", self.arch)
                .replace("{{bundle_type}}", installer)
                .parse()?;

            log::debug!("checking for updates {url}");

            #[cfg(feature = "rustls-tls")]
            if rustls::crypto::CryptoProvider::get_default().is_none() {
                // This can only fail if there is already a default provider which we checked for already.
                let _ = rustls::crypto::ring::default_provider().install_default();
            }

            let mut request = ClientBuilder::new().user_agent(UPDATER_USER_AGENT);
            if self.context.config.dangerous_accept_invalid_certs {
                request = request.danger_accept_invalid_certs(true);
            }
            if self.context.config.dangerous_accept_invalid_hostnames {
                request = request.danger_accept_invalid_hostnames(true);
            }
            if let Some(timeout) = self.timeout {
                request = request.timeout(timeout);
            }
            if self.no_proxy {
                log::debug!("disabling proxy");
                request = request.no_proxy();
            } else if let Some(ref proxy) = self.proxy {
                log::debug!("using proxy {proxy}");
                let proxy = reqwest::Proxy::all(proxy.as_str())?;
                request = request.proxy(proxy);
            }

            if let Some(ref configure_client) = self.context.configure_client {
                request = configure_client(request);
            }

            let response = request
                .build()?
                .get(url)
                .headers(headers.clone())
                .send()
                .await;

            match response {
                Ok(res) => {
                    if res.status().is_success() {
                        // no updates found!
                        if StatusCode::NO_CONTENT == res.status() {
                            log::debug!("update endpoint returned 204 No Content");
                            return Ok(None);
                        };

                        let update_response: serde_json::Value = res.json().await?;
                        log::debug!("update response: {update_response:?}");
                        raw_json = Some(update_response.clone());
                        match serde_json::from_value::<RemoteRelease>(update_response)
                            .map_err(Into::into)
                        {
                            Ok(release) => {
                                log::debug!("parsed release response {release:?}");
                                last_error = None;
                                remote_release = Some(release);
                                // we found a release, break the loop
                                break;
                            }
                            Err(err) => {
                                log::error!("failed to deserialize update response: {err}");
                                last_error = Some(err)
                            }
                        }
                    } else {
                        log::error!(
                            "update endpoint did not respond with a successful status code"
                        );
                    }
                }
                Err(err) => {
                    log::error!("failed to check for updates: {err}");
                    last_error = Some(err.into())
                }
            }
        }

        // Last error is cleaned on success.
        // Shouldn't be triggered if we had a successfull call
        if let Some(error) = last_error {
            return Err(error);
        }

        // Extracted remote metadata
        let release = remote_release.ok_or(Error::ReleaseNotFound)?;

        self.update_from_release(release, raw_json.unwrap(), target)
    }

    /// Restores an update from a previously saved [`Update::raw_json`] without making a request.
    ///
    /// Applies the same target selection and version comparator as [`Self::check`]. Runtime
    /// configuration, including the public key and installation path, comes from this updater,
    /// not from the cached metadata. Returns `None` if the release is no longer an update.
    ///
    /// The cached metadata is not authenticated, so the restored update always requires the
    /// package signature to bind the announced version, as if [`Config::require_signed_version`]
    /// was enabled. Otherwise modified metadata could pair a newer version number with an older,
    /// validly signed package. Packages signed without a version (by Tauri CLI releases that
    /// predate `--app-version`) are rejected with [`Error::MissingSignedVersion`].
    ///
    /// [`Update::install`] verifies the bytes it is given, and [`Update::verify`] can be used to
    /// check a cached package before installing it.
    ///
    /// # Errors
    ///
    /// - [`Error::UnsupportedOs`]: no target was set and the updater does not support the
    ///   current operating system.
    /// - A deserialization error when the metadata is not a valid release manifest.
    /// - [`Error::TargetNotFound`] or [`Error::TargetsNotFound`]: the release is an update but
    ///   the manifest has no entry for the current target.
    pub fn restore_update(&self, raw_json: serde_json::Value) -> Result<Option<Update>> {
        let target = self.current_target()?;
        let release = serde_json::from_value(raw_json.clone())?;
        let mut update = self.update_from_release(release, raw_json, target)?;
        if let Some(update) = &mut update {
            update.context.config.require_signed_version = true;
        }
        Ok(update)
    }

    /// The `{{target}}` value: the user provided target or the current operating system.
    fn current_target(&self) -> Result<&str> {
        match &self.target {
            Some(target) => Ok(target),
            None => updater_os().ok_or(Error::UnsupportedOs),
        }
    }

    fn update_from_release(
        &self,
        release: RemoteRelease,
        raw_json: serde_json::Value,
        target: &str,
    ) -> Result<Option<Update>> {
        let should_update = match self.version_comparator.as_ref() {
            Some(comparator) => comparator(self.current_version.clone(), release.clone()),
            None => release.version > self.current_version,
        };

        // a release that is not an update is not an error, even if it has no entry for this target
        if !should_update {
            return Ok(None);
        }

        let installer = installer_for_bundle_type(bundle_type());
        let (download_url, signature) = self.get_urls(&release, &installer)?;

        Ok(Some(Update {
            current_version: self.current_version.to_string(),
            target: target.to_owned(),
            extract_path: self.extract_path.clone(),
            version: release.version.to_string(),
            date: release.pub_date,
            download_url: download_url.clone(),
            signature: signature.to_owned(),
            body: release.notes,
            raw_json,
            timeout: None,
            proxy: self.proxy.clone(),
            no_proxy: self.no_proxy,
            headers: self.headers.clone(),
            context: self.context.clone(),
        }))
    }

    fn get_urls<'a>(
        &self,
        release: &'a RemoteRelease,
        installer: &Option<Installer>,
    ) -> Result<(&'a Url, &'a String)> {
        // Use the user provided target
        if let Some(target) = &self.target {
            return Ok((release.download_url(target)?, release.signature(target)?));
        }

        // Or else we search for [`{os}-{arch}-{installer}`, `{os}-{arch}`] in order
        let os = updater_os().ok_or(Error::UnsupportedOs)?;
        let arch = self.arch;
        let mut targets = Vec::new();
        if let Some(installer) = installer {
            let installer = installer.name();
            targets.push(format!("{os}-{arch}-{installer}"));
        }
        targets.push(format!("{os}-{arch}"));

        for target in &targets {
            log::debug!("Searching for updater target '{target}' in release data");
            if let (Ok(download_url), Ok(signature)) =
                (release.download_url(target), release.signature(target))
            {
                return Ok((download_url, signature));
            };
        }

        Err(Error::TargetsNotFound(targets))
    }
}

/// An update announced by the remote server, returned by [`Updater::check`].
///
/// Use [`Update::download`] followed by [`Update::install`], or [`Update::download_and_install`],
/// to apply it.
#[derive(Clone)]
pub struct Update {
    /// Update description
    pub body: Option<String>,
    /// Version used to check for update
    pub current_version: String,
    /// Version announced
    pub version: String,
    /// Update publish date
    pub date: Option<OffsetDateTime>,
    /// The `{{target}}` variable we replace in the endpoint and search for in the JSON,
    /// this is either the user provided target or the current operating system by default
    pub target: String,
    /// Download URL announced
    pub download_url: Url,
    /// Signature announced
    pub signature: String,
    /// The raw version of server's JSON response. Useful if the response contains additional fields that the updater doesn't handle.
    pub raw_json: serde_json::Value,
    /// Request timeout
    pub timeout: Option<Duration>,
    /// Request proxy
    pub proxy: Option<Url>,
    /// Disable system proxy
    pub no_proxy: bool,
    /// Request headers
    pub headers: HeaderMap,
    /// Extract path
    #[allow(unused)]
    extract_path: PathBuf,
    context: UpdaterContext,
}

impl Resource for Update {}

impl Update {
    /// Downloads the updater package, verifies it then return it as bytes.
    ///
    /// Use [`Update::install`] to install it
    pub async fn download<C: FnMut(usize, Option<u64>), D: FnOnce()>(
        &self,
        mut on_chunk: C,
        on_download_finish: D,
    ) -> Result<Vec<u8>> {
        // not enforced (unlike for the endpoints) as that would break existing releases, but the
        // artifact then travels in plaintext: only its signature protects it
        // TODO(v3): enforce it
        if self.download_url.scheme() != "https"
            && !self.context.config.dangerous_insecure_transport_protocol
        {
            log::warn!(
                "the update download URL {} does not use the `https` protocol",
                self.download_url
            );
        }

        // set our headers
        let mut headers = self.headers.clone();
        if !headers.contains_key(ACCEPT) {
            headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
        }

        let mut request = ClientBuilder::new().user_agent(UPDATER_USER_AGENT);
        if self.context.config.dangerous_accept_invalid_certs {
            request = request.danger_accept_invalid_certs(true);
        }
        if self.context.config.dangerous_accept_invalid_hostnames {
            request = request.danger_accept_invalid_hostnames(true);
        }
        if let Some(timeout) = self.timeout {
            request = request.timeout(timeout);
        }
        if self.no_proxy {
            request = request.no_proxy();
        } else if let Some(ref proxy) = self.proxy {
            let proxy = reqwest::Proxy::all(proxy.as_str())?;
            request = request.proxy(proxy);
        }
        if let Some(ref configure_client) = self.context.configure_client {
            request = configure_client(request);
        }
        let response = request
            .build()?
            .get(self.download_url.clone())
            .headers(headers)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(Error::Network(format!(
                "Download request failed with status: {}",
                response.status()
            )));
        }

        let content_length: Option<u64> = response
            .headers()
            .get("Content-Length")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok());

        let mut buffer = Vec::new();

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            on_chunk(chunk.len(), content_length);
            buffer.extend(chunk);
        }
        on_download_finish();

        self.verify(&buffer)?;

        Ok(buffer)
    }

    /// Verifies package bytes using this update's signature and the configured public key.
    ///
    /// This performs the same checks as [`Self::download`] and [`Self::install`], including
    /// signed-version validation, without making a request or installing anything. Use it to
    /// discard a corrupted or tampered cached package early.
    pub fn verify(&self, bytes: &[u8]) -> Result<()> {
        verify_signature(
            bytes,
            &self.signature,
            &self.context.config.pubkey,
            &self.version,
            self.context.config.require_signed_version,
        )
    }

    /// Installs the updater package downloaded by [`Update::download`] or cached from a previous
    /// download.
    ///
    /// The bytes are verified with [`Self::verify`] first, so a package that does not match this
    /// update's signature is never installed.
    ///
    /// ## Platform-specific:
    ///
    /// - **Windows:** This function exits the app after launching the updater installer successfully
    /// - **macOS / Linux:** You need to relaunch the app to run the newly install version
    pub fn install(&self, bytes: impl AsRef<[u8]>) -> Result<()> {
        let bytes = bytes.as_ref();
        self.verify(bytes)?;
        self.install_inner(bytes)
    }

    /// Downloads and installs the updater package
    ///
    /// ## Platform-specific:
    ///
    /// - **Windows:** This function exits the app after launching the updater installer successfully
    /// - **macOS / Linux:** You need to relaunch the app to run the newly install version
    pub async fn download_and_install<C: FnMut(usize, Option<u64>), D: FnOnce()>(
        &self,
        on_chunk: C,
        on_download_finish: D,
    ) -> Result<()> {
        // `download` already verified the bytes
        let bytes = self.download(on_chunk, on_download_finish).await?;
        self.install_inner(&bytes)
    }

    /// Updates are not supported on mobile, where apps are updated through the app stores.
    #[cfg(mobile)]
    fn install_inner(&self, _bytes: &[u8]) -> Result<()> {
        Err(Error::UnsupportedOs)
    }

    /// Whether the Windows installer should restart the app after installed, default is `true`
    #[cfg_attr(not(windows), allow(unused))]
    pub fn restart_after_install(mut self, restart_after_install: bool) -> Self {
        #[cfg(windows)]
        {
            self.context.restart_after_install = restart_after_install;
        }
        self
    }
}

#[cfg(windows)]
enum WindowsUpdaterType {
    Nsis {
        path: PathBuf,
        #[allow(unused)]
        temp: Option<tempfile::TempPath>,
    },
    Msi {
        path: PathBuf,
        #[allow(unused)]
        temp: Option<tempfile::TempPath>,
    },
}

#[cfg(windows)]
impl WindowsUpdaterType {
    fn nsis(path: PathBuf, temp: Option<tempfile::TempPath>) -> Self {
        Self::Nsis { path, temp }
    }

    fn msi(path: PathBuf, temp: Option<tempfile::TempPath>) -> Self {
        Self::Msi {
            path: path.wrap_in_quotes(),
            temp,
        }
    }
}

#[cfg(windows)]
impl Config {
    fn install_mode(&self) -> crate::config::WindowsUpdateInstallMode {
        self.windows
            .as_ref()
            .map(|w| w.install_mode.clone())
            .unwrap_or_default()
    }
}

/// Windows
#[cfg(windows)]
impl Update {
    /// ### Expected structure:
    /// ├── [AppName]_[version]_x64.msi              # Application MSI
    /// ├── [AppName]_[version]_x64-setup.exe        # NSIS installer
    /// ├── [AppName]_[version]_x64.msi.zip          # ZIP generated by tauri-bundler
    /// │   └──[AppName]_[version]_x64.msi           # Application MSI
    /// ├── [AppName]_[version]_x64-setup.exe.zip          # ZIP generated by tauri-bundler
    /// │   └──[AppName]_[version]_x64-setup.exe           # NSIS installer
    /// └── ...
    fn install_inner(&self, bytes: &[u8]) -> Result<()> {
        use windows_sys::{
            Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOW},
            w,
        };

        let updater_type = self.extract(bytes)?;

        let file = match &updater_type {
            WindowsUpdaterType::Nsis { path, .. } => path.as_os_str().to_os_string(),
            WindowsUpdaterType::Msi { .. } => std::env::var("SYSTEMROOT").as_ref().map_or_else(
                |_| OsString::from("msiexec.exe"),
                |p| OsString::from(format!("{p}\\System32\\msiexec.exe")),
            ),
        };
        let parameters = self.updater_parameters(&updater_type);

        log::debug!("Executing updater {file:?} with parameters: {parameters:?}");

        let file = encode_wide(file);
        let parameters = encode_wide(parameters);

        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                w!("open"),
                file.as_ptr(),
                parameters.as_ptr(),
                std::ptr::null(),
                SW_SHOW,
            )
        };
        finish_windows_launch(result as isize, || {
            if let Some(on_before_exit) = self.context.on_before_exit.as_ref() {
                log::debug!("running on_before_exit hook");
                on_before_exit();
            }
        })?;

        std::process::exit(0);
    }

    fn updater_parameters(&self, updater_type: &WindowsUpdaterType) -> OsString {
        let install_mode = self.context.config.install_mode();
        let current_args = &self.context.current_exe_args[1..];

        match updater_type {
            WindowsUpdaterType::Nsis { .. } => {
                let mut installer_args: Vec<&OsStr> = Vec::new();
                installer_args.extend(install_mode.nsis_args().iter().map(OsStr::new));
                installer_args.push(OsStr::new("/UPDATE"));

                let nsis_current_exe_arg;
                if self.context.restart_after_install {
                    nsis_current_exe_arg = current_args
                        .iter()
                        .map(escape_nsis_current_exe_arg)
                        .collect::<Vec<_>>();

                    installer_args.extend(
                        install_mode
                            .nsis_restart_after_install_args()
                            .iter()
                            .map(OsStr::new),
                    );
                    installer_args.push(OsStr::new("/ARGS"));
                    installer_args.extend(nsis_current_exe_arg.iter().map(OsStr::new));
                }

                installer_args.extend(self.installer_args());

                installer_args.join(OsStr::new(" "))
            }
            WindowsUpdaterType::Msi { path, .. } => {
                let mut installer_args: Vec<&OsStr> = vec![OsStr::new("/i"), path.as_os_str()];
                installer_args.extend(install_mode.msiexec_args().iter().map(OsStr::new));
                installer_args.push(OsStr::new("/promptrestart"));
                installer_args.extend(self.installer_args());

                let msi_current_exe_arg;
                if self.context.restart_after_install {
                    msi_current_exe_arg = format!(
                        "LAUNCHAPPARGS=\"{}\"",
                        current_args
                            .iter()
                            .map(escape_msi_property_arg)
                            .collect::<Vec<_>>()
                            .join(" ")
                    );

                    installer_args.extend(
                        install_mode
                            .msi_restart_after_install_args()
                            .iter()
                            .map(OsStr::new),
                    );
                    installer_args.push(OsStr::new(&msi_current_exe_arg));
                }

                installer_args.join(OsStr::new(" "))
            }
        }
    }

    fn installer_args(
        &self,
    ) -> std::iter::Map<std::slice::Iter<'_, OsString>, fn(&OsString) -> &OsStr> {
        self.context.installer_args.iter().map(OsStr::new)
    }

    fn extract(&self, bytes: &[u8]) -> Result<WindowsUpdaterType> {
        #[cfg(feature = "zip")]
        if infer::archive::is_zip(bytes) {
            return self.extract_zip(bytes);
        }

        self.extract_exe(bytes)
    }

    fn make_temp_dir(&self) -> Result<PathBuf> {
        Ok(tempfile::Builder::new()
            .prefix(&format!(
                "{}-{}-updater-",
                self.context.app_name, self.version
            ))
            .tempdir()?
            .keep())
    }

    #[cfg(feature = "zip")]
    fn extract_zip(&self, bytes: &[u8]) -> Result<WindowsUpdaterType> {
        let temp_dir = self.make_temp_dir()?;

        let archive = std::io::Cursor::new(bytes);
        let mut extractor = zip::ZipArchive::new(archive)?;
        extractor.extract(&temp_dir)?;

        let paths = std::fs::read_dir(&temp_dir)?;
        for path in paths {
            let path = path?.path();
            let ext = path.extension();
            if ext == Some(OsStr::new("exe")) {
                return Ok(WindowsUpdaterType::nsis(path, None));
            } else if ext == Some(OsStr::new("msi")) {
                return Ok(WindowsUpdaterType::msi(path, None));
            }
        }

        Err(crate::Error::BinaryNotFoundInArchive)
    }

    fn extract_exe(&self, bytes: &[u8]) -> Result<WindowsUpdaterType> {
        if infer::app::is_exe(bytes) {
            let (path, temp) = self.write_to_temp(bytes, ".exe")?;
            Ok(WindowsUpdaterType::nsis(path, temp))
        } else if infer::archive::is_msi(bytes) {
            let (path, temp) = self.write_to_temp(bytes, ".msi")?;
            Ok(WindowsUpdaterType::msi(path, temp))
        } else {
            Err(crate::Error::InvalidUpdaterFormat)
        }
    }

    fn write_to_temp(
        &self,
        bytes: &[u8],
        ext: &str,
    ) -> Result<(PathBuf, Option<tempfile::TempPath>)> {
        use std::io::Write;

        let temp_dir = self.make_temp_dir()?;
        let mut temp_file = tempfile::Builder::new()
            .prefix(&format!(
                "{}-{}-installer",
                self.context.app_name, self.version
            ))
            .suffix(ext)
            .rand_bytes(0)
            .tempfile_in(temp_dir)?;
        temp_file.write_all(bytes)?;

        let temp = temp_file.into_temp_path();
        Ok((temp.to_path_buf(), Some(temp)))
    }
}

/// Linux (AppImage, Deb, RPM)
#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
impl Update {
    /// ### Expected structure:
    /// ├── [AppName]_[version]_amd64.AppImage.tar.gz    # GZ generated by tauri-bundler
    /// │   └──[AppName]_[version]_amd64.AppImage        # Application AppImage
    /// ├── [AppName]_[version]_amd64.deb                # Debian package
    /// ├── [AppName]_[version]_amd64.rpm                # RPM package
    /// └── ...
    ///
    fn install_inner(&self, bytes: &[u8]) -> Result<()> {
        match installer_for_bundle_type(bundle_type()) {
            Some(Installer::Deb) => self.install_deb(bytes),
            Some(Installer::Rpm) => self.install_rpm(bytes),
            _ => self.install_appimage(bytes),
        }
    }

    fn install_appimage(&self, bytes: &[u8]) -> Result<()> {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let extract_path_metadata = self.extract_path.metadata()?;

        // check the payload before touching the current AppImage
        let is_gz = infer::archive::is_gz(bytes);
        #[cfg(not(feature = "zip"))]
        if is_gz {
            log::error!(
                "the update is a compressed AppImage, which can only be installed when the updater's `zip` feature is enabled"
            );
            return Err(Error::InvalidUpdaterFormat);
        }
        // AppImages are ELF executables
        if !is_gz && !infer::app::is_elf(bytes) {
            log::error!("the update is neither an AppImage nor a compressed AppImage");
            return Err(Error::InvalidUpdaterFormat);
        }

        for tmp_dir_location in self.tmp_dir_locations() {
            let Some(tmp_dir_location) = tmp_dir_location() else {
                continue;
            };
            // a location that cannot be used moves on to the next one
            let tmp_dir = match tempfile::Builder::new()
                .prefix("tauri_current_app")
                .tempdir_in(&tmp_dir_location)
            {
                Ok(tmp_dir) => tmp_dir,
                Err(err) => {
                    log::debug!(
                        "failed to create a temporary directory in {}: {err}",
                        tmp_dir_location.display()
                    );
                    continue;
                }
            };
            if let Ok(tmp_dir_metadata) = tmp_dir.path().metadata()
                && extract_path_metadata.dev() == tmp_dir_metadata.dev()
            {
                let mut perms = tmp_dir_metadata.permissions();
                perms.set_mode(0o700);
                std::fs::set_permissions(tmp_dir.path(), perms)?;

                let tmp_app_image = &tmp_dir.path().join("current_app.AppImage");

                let permissions = std::fs::metadata(&self.extract_path)?.permissions();

                // create a backup of our current app image
                match std::fs::rename(&self.extract_path, tmp_app_image) {
                    Ok(()) => {}
                    Err(err) if err.kind() == std::io::ErrorKind::CrossesDevices => continue,
                    Err(err) => return Err(err.into()),
                }

                #[cfg(feature = "zip")]
                if is_gz {
                    log::debug!("extracting AppImage");
                    // extract the buffer to the tmp_dir
                    // we extract our signed archive into our final directory without any temp file
                    let archive = std::io::Cursor::new(bytes);
                    let decoder = flate2::read::GzDecoder::new(archive);
                    let mut archive = tar::Archive::new(decoder);
                    for mut entry in archive.entries()?.flatten() {
                        if let Ok(path) = entry.path()
                            && path.extension() == Some(OsStr::new("AppImage"))
                        {
                            // if something went wrong during the extraction, we should restore previous app
                            if let Err(err) = entry.unpack(&self.extract_path) {
                                std::fs::rename(tmp_app_image, &self.extract_path)?;
                                return Err(err.into());
                            }
                            // early finish we have everything we need here
                            return Ok(());
                        }
                    }
                    // if we have not returned early we should restore the backup
                    std::fs::rename(tmp_app_image, &self.extract_path)?;
                    return Err(Error::BinaryNotFoundInArchive);
                }

                log::debug!("rewriting AppImage");
                return match std::fs::write(&self.extract_path, bytes)
                    .and_then(|_| std::fs::set_permissions(&self.extract_path, permissions))
                {
                    Err(err) => {
                        // if something went wrong during the extraction, we should restore previous app
                        std::fs::rename(tmp_app_image, &self.extract_path)?;
                        Err(err.into())
                    }
                    Ok(_) => Ok(()),
                };
            }
        }

        Err(Error::TempDirNotOnSameMountPoint)
    }

    /// Directories to try, in order, for the temporary files of an install: the system temporary
    /// directory, the user cache directory and the directory holding the app.
    fn tmp_dir_locations(&self) -> Vec<Box<dyn FnOnce() -> Option<PathBuf> + '_>> {
        vec![
            Box::new(|| Some(std::env::temp_dir())),
            Box::new(dirs::cache_dir),
            Box::new(|| self.extract_path.parent().map(Path::to_path_buf)),
        ]
    }

    fn install_deb(&self, bytes: &[u8]) -> Result<()> {
        // First verify the bytes are actually a .deb package
        if !infer::archive::is_deb(bytes) {
            log::warn!("update is not a valid deb package");
            return Err(Error::InvalidUpdaterFormat);
        }

        self.try_tmp_locations(bytes, "dpkg", "-i", "deb")
    }

    fn install_rpm(&self, bytes: &[u8]) -> Result<()> {
        // First verify the bytes are actually a .rpm package
        if !infer::archive::is_rpm(bytes) {
            return Err(Error::InvalidUpdaterFormat);
        }
        self.try_tmp_locations(bytes, "rpm", "-U", "rpm")
    }

    fn try_tmp_locations(
        &self,
        bytes: &[u8],
        install_cmd: &str,
        install_arg: &str,
        package_extension: &str,
    ) -> Result<()> {
        // Try writing to multiple temp locations until one succeeds
        for tmp_dir_location in self.tmp_dir_locations() {
            let Some(path) = tmp_dir_location() else {
                continue;
            };
            let prefix = format!("tauri_{package_extension}_update");
            if let Ok(tmp_dir) = tempfile::Builder::new().prefix(&prefix).tempdir_in(path) {
                let pkg_path = tmp_dir.path().join(format!("package.{package_extension}"));

                // Try writing the .deb / .rpm file
                if std::fs::write(&pkg_path, bytes).is_ok() {
                    // If write succeeds, proceed with installation
                    return self.try_install_with_privileges(&pkg_path, install_cmd, install_arg);
                }
                // If write fails, continue to next temp location
            }
        }

        // If we get here, all temp locations failed
        Err(Error::TempDirNotFound)
    }

    fn try_install_with_privileges(
        &self,
        pkg_path: &Path,
        install_cmd: &str,
        install_arg: &str,
    ) -> Result<()> {
        // 1. First try using pkexec (graphical sudo prompt)
        if let Ok(status) = std::process::Command::new("pkexec")
            .arg(install_cmd)
            .arg(install_arg)
            .arg(pkg_path)
            .status()
            && status.success()
        {
            log::debug!("installed {pkg_path:?} with pkexec");
            return Ok(());
        }

        // 2. Try zenity or kdialog for a graphical sudo experience
        if let Ok(password) = self.get_password_graphically()
            && self.install_with_sudo(pkg_path, &password, install_cmd, install_arg)?
        {
            log::debug!("installed {pkg_path:?} with GUI sudo");
            return Ok(());
        }

        // 3. Final fallback: terminal sudo
        let status = std::process::Command::new("sudo")
            .arg(install_cmd)
            .arg(install_arg)
            .arg(pkg_path)
            .status()?;

        if status.success() {
            log::debug!("installed {pkg_path:?} with sudo");
            Ok(())
        } else {
            Err(Error::PackageInstallFailed)
        }
    }

    fn get_password_graphically(&self) -> Result<String> {
        // Try zenity first
        let zenity_result = std::process::Command::new("zenity")
            .args([
                "--password",
                "--title=Authentication Required",
                "--text=Enter your password to install the update:",
            ])
            .output();

        if let Ok(output) = zenity_result
            && output.status.success()
        {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }

        // Fall back to kdialog if zenity fails or isn't available
        let kdialog_result = std::process::Command::new("kdialog")
            .args(["--password", "Enter your password to install the update:"])
            .output();

        if let Ok(output) = kdialog_result
            && output.status.success()
        {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }

        Err(Error::AuthenticationFailed)
    }

    fn install_with_sudo(
        &self,
        pkg_path: &Path,
        password: &str,
        install_cmd: &str,
        install_arg: &str,
    ) -> Result<bool> {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let mut child = Command::new("sudo")
            .arg("-S") // read password from stdin
            .arg(install_cmd)
            .arg(install_arg)
            .arg(pkg_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        if let Some(mut stdin) = child.stdin.take() {
            // Write password to stdin
            writeln!(stdin, "{password}")?;
        }

        let status = child.wait()?;
        Ok(status.success())
    }
}

/// MacOS
#[cfg(target_os = "macos")]
impl Update {
    /// ### Expected structure:
    /// ├── [AppName]_[version]_x64.app.tar.gz       # GZ generated by tauri-bundler
    /// │   └──[AppName].app                         # Main application
    /// │      └── Contents                          # Application contents...
    /// │          └── ...
    /// └── ...
    fn install_inner(&self, bytes: &[u8]) -> Result<()> {
        use flate2::read::GzDecoder;
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let cursor = std::io::Cursor::new(bytes);
        let mut extracted_files: Vec<PathBuf> = Vec::new();

        // The app is moved with renames, which only work within one file system, so the
        // temp dirs for backup and extraction go on the app's volume: in the system temp
        // dir when it is there, and next to the app otherwise. If neither is, refuse now
        // rather than fail after the current app has been moved away. The renames act on
        // the install path itself, so a symlink there is not followed.
        let app_dev = std::fs::symlink_metadata(&self.extract_path)?.dev();
        let tmp_root = [
            Some(std::env::temp_dir()),
            self.extract_path.parent().map(Path::to_path_buf),
        ]
        .into_iter()
        .flatten()
        .find(|dir| dir.metadata().is_ok_and(|m| m.dev() == app_dev))
        .ok_or(Error::TempDirNotOnSameMountPoint)?;

        let tmp_backup_dir = tempfile::Builder::new()
            .prefix("tauri_current_app")
            .tempdir_in(&tmp_root)?;

        let tmp_extract_dir = tempfile::Builder::new()
            .prefix("tauri_updated_app")
            .tempdir_in(&tmp_root)?;

        let decoder = GzDecoder::new(cursor);
        let mut archive = tar::Archive::new(decoder);

        // Extract files to temporary directory
        for entry in archive.entries()? {
            let mut entry = entry?;
            let collected_path: PathBuf = entry.path()?.iter().skip(1).collect();
            let extraction_path = tmp_extract_dir.path().join(&collected_path);

            // Ensure parent directories exist
            if let Some(parent) = extraction_path.parent() {
                std::fs::create_dir_all(parent)?;
            }

            if let Err(err) = entry.unpack(&extraction_path) {
                // Cleanup on error
                std::fs::remove_dir_all(tmp_extract_dir.path()).ok();
                return Err(err.into());
            }
            extracted_files.push(extraction_path);
        }

        // The temp dir becomes the installed bundle's root, and tempfile creates it
        // with mode 0700, which stops every other user of the machine from launching
        // the updated app.
        std::fs::set_permissions(
            tmp_extract_dir.path(),
            std::fs::Permissions::from_mode(0o755),
        )?;

        // Exchange the current app and the new one in a single step where the file
        // system supports it, so the install path is never empty; the previous app
        // then sits in the extraction temp dir, which is removed on drop. Where the
        // swap is not supported, fall back to two renames with a restore on failure.
        // File systems report that with different errors (`ENOTSUP` on HFS+,
        // `EOPNOTSUPP`, `ENOSYS` or `EINVAL` elsewhere), so anything but a permission
        // error, which needs the privileged install instead, gets the fallback.
        let backup = tmp_backup_dir.path().join("current_app");
        let moved = match swap_bundle(&self.extract_path, tmp_extract_dir.path()) {
            Err(err) if err.kind() != std::io::ErrorKind::PermissionDenied => {
                log::debug!("cannot swap the app bundles ({err}), moving them instead");
                replace_bundle(&self.extract_path, tmp_extract_dir.path(), &backup)
            }
            other => other,
        };
        let need_authorization = match moved {
            Ok(()) => false,
            Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => true,
            Err(err) => {
                if let Some(kept) = keep_backup_if_not_restored(
                    &self.extract_path,
                    tmp_backup_dir,
                    &backup,
                    std::env::home_dir().as_deref(),
                ) {
                    log::error!("failed to install the update: {err}");
                    return Err(Error::PreviousAppNotRestored(kept));
                }
                std::fs::remove_dir_all(tmp_extract_dir.path()).ok();
                return Err(err.into());
            }
        };

        if need_authorization {
            log::debug!("app installation needs admin privileges");
            // Use AppleScript to swap the bundles, or move them where the file system
            // cannot swap, with admin privileges: the current app is only deleted once
            // the new one is in place.
            let apple_script = format!(
                "do shell script {} with administrator privileges",
                applescript_string(&privileged_install_command(
                    &self.extract_path,
                    tmp_extract_dir.path(),
                    &backup
                ))
            );

            let (tx, rx) = std::sync::mpsc::channel();
            let res = (self.context.run_on_main_thread)(Box::new(move || {
                let mut script =
                    osakit::Script::new_from_source(osakit::Language::AppleScript, &apple_script);
                let result = match script.compile() {
                    Ok(()) => script.execute().map(|_| ()).map_err(|e| e.to_string()),
                    Err(e) => Err(e.to_string()),
                };
                let _ = tx.send(result);
            }));
            // `recv` only fails when the closure never ran, which `res` then reports
            let result = res
                .map_err(|e| e.to_string())
                .and_then(|()| rx.recv().map_err(|e| e.to_string())?);

            if let Err(err) = result {
                log::error!("failed to move the new app into place: {err}");
                if let Some(kept) = keep_backup_if_not_restored(
                    &self.extract_path,
                    tmp_backup_dir,
                    &backup,
                    std::env::home_dir().as_deref(),
                ) {
                    return Err(Error::PreviousAppNotRestored(kept));
                }
                std::fs::remove_dir_all(tmp_extract_dir.path()).ok();
                return Err(Error::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "Failed to move the new app into place",
                )));
            }
        }

        let _ = std::process::Command::new("touch")
            .arg(&self.extract_path)
            .status();

        Ok(())
    }
}

/// Exchange `target` and `staged` atomically, so there is no instant at which
/// `target` does not exist. APFS supports the swap; other file systems return an
/// error, and the caller falls back to [`replace_bundle`].
#[cfg(target_os = "macos")]
fn swap_bundle(target: &Path, staged: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let from = CString::new(staged.as_os_str().as_bytes())?;
    let to = CString::new(target.as_os_str().as_bytes())?;
    // SAFETY: both pointers are valid NUL-terminated strings that outlive the call,
    // and `renamex_np` only reads them.
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_SWAP) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Move `staged` into `target`, keeping what was at `target` in `backup` until the
/// move has succeeded. If the second rename fails, the first is undone so `target`
/// is left exactly as it was. Both renames must be within one file system.
#[cfg(any(target_os = "macos", test))]
fn replace_bundle(target: &Path, staged: &Path, backup: &Path) -> std::io::Result<()> {
    std::fs::rename(target, backup)?;
    if let Err(err) = std::fs::rename(staged, target) {
        // Best effort: the error worth reporting is the one from the failed move.
        let _ = std::fs::rename(backup, target);
        return Err(err);
    }
    Ok(())
}

/// Exchanges the two paths it is given like [`swap_bundle`], for the privileged install:
/// the shell has no command for the swap, but `osascript` running this JavaScript for
/// Automation can call `renamex_np` (`2` is `RENAME_SWAP`), and ships with every macOS.
/// It prints `swapped` or `failed`, so the caller can tell a swap that did not happen
/// from an `osascript` failure that leaves unknown whether it did.
#[cfg(target_os = "macos")]
const SWAP_BUNDLE_JXA: &str = r#"function run(argv) {
  ObjC.import("stdio");
  return $.renamex_np(argv[0], argv[1], 2) === 0 ? "swapped" : "failed";
}"#;

/// The shell command the privileged install runs: the same swap as [`swap_bundle`], and
/// where the file system cannot swap, the same moves as [`replace_bundle`], deleting the
/// previous app only once the new one is in place. The moves only run once the swap is
/// known not to have happened, since after a swap they would put the previous app back.
#[cfg(target_os = "macos")]
fn privileged_install_command(target: &Path, staged: &Path, backup: &Path) -> String {
    let swap = sh_quote(Path::new(SWAP_BUNDLE_JXA));
    let target = sh_quote(target);
    let staged = sh_quote(staged);
    let backup = sh_quote(backup);
    format!(
        "case \"$(/usr/bin/osascript -l JavaScript -e {swap} {staged} {target} 2>/dev/null)\" in swapped) rm -rf {staged};; failed) mv -f {target} {backup} && {{ mv -f {staged} {target} || {{ mv -f {backup} {target}; exit 1; }}; }} && rm -rf {backup};; *) exit 1;; esac"
    )
}

/// Quotes `path` as a single `sh` word, whatever characters it holds.
#[cfg(target_os = "macos")]
fn sh_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"))
}

/// Quotes `s` as an AppleScript string literal.
#[cfg(target_os = "macos")]
fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', r"\\").replace('"', "\\\""))
}

/// After a failed install, returns where the previous app is if it never made it back to
/// `target`. `backup` is then the only copy left, and usually sits in the system temp dir,
/// which macOS empties on its own, so it is moved next to `target`, or to `fallback_dir`
/// (the home folder) when that is not writable, as `<name> (previous version).app`. If
/// neither works, `backup_dir` is kept rather than deleted on drop as it otherwise is.
#[cfg(any(target_os = "macos", test))]
fn keep_backup_if_not_restored(
    target: &Path,
    backup_dir: tempfile::TempDir,
    backup: &Path,
    fallback_dir: Option<&Path>,
) -> Option<PathBuf> {
    if std::fs::symlink_metadata(target).is_ok() || std::fs::symlink_metadata(backup).is_err() {
        return None;
    }

    let mut name = target.file_stem().unwrap_or_default().to_os_string();
    name.push(" (previous version)");
    if let Some(extension) = target.extension() {
        name.push(".");
        name.push(extension);
    }
    let kept = [target.parent(), fallback_dir]
        .into_iter()
        .flatten()
        .map(|dir| dir.join(&name))
        // `rename` replaces an empty directory, so never move onto anything already there
        .filter(|kept| std::fs::symlink_metadata(kept).is_err())
        .find(|kept| std::fs::rename(backup, kept).is_ok());

    match kept {
        Some(kept) => Some(kept),
        None => {
            let _ = backup_dir.keep();
            Some(backup.to_path_buf())
        }
    }
}

/// Gets the base target string used by the updater. If bundle type is available it
/// will be added to this string when selecting the download URL and signature.
/// `tauri::utils::platform::bundle_type` method is used to obtain current bundle type.
pub fn target() -> Option<String> {
    if let (Some(target), Some(arch)) = (updater_os(), updater_arch()) {
        Some(format!("{target}-{arch}"))
    } else {
        None
    }
}

fn updater_os() -> Option<&'static str> {
    if cfg!(target_os = "linux") {
        Some("linux")
    } else if cfg!(target_os = "macos") {
        // TODO shouldn't this be macos instead?
        Some("darwin")
    } else if cfg!(target_os = "windows") {
        Some("windows")
    } else {
        None
    }
}

fn updater_arch() -> Option<&'static str> {
    if cfg!(target_arch = "x86") {
        Some("i686")
    } else if cfg!(target_arch = "x86_64") {
        Some("x86_64")
    } else if cfg!(target_arch = "arm") {
        Some("armv7")
    } else if cfg!(target_arch = "aarch64") {
        Some("aarch64")
    } else if cfg!(target_arch = "riscv64") {
        Some("riscv64")
    } else {
        None
    }
}

/// Resolves the path the update must be installed to from the path of the application executable.
///
/// This is the directory holding the executable, except on macOS where the `.app` bundle path is
/// returned for executables living in `Contents/MacOS`.
///
/// # Errors
///
/// Returns [`Error::FailedToDetermineExtractPath`] when the path has no parent directory.
pub fn extract_path_from_executable(executable_path: &Path) -> Result<PathBuf> {
    // Return the path of the current executable by default
    // Example C:\Program Files\My App\
    let extract_path = executable_path
        .parent()
        .map(PathBuf::from)
        .ok_or(Error::FailedToDetermineExtractPath)?;

    // MacOS example binary is in /Applications/TestApp.app/Contents/MacOS/myApp
    // We need to get /Applications/<app>.app
    // TODO(lemarier): Need a better way here
    // Maybe we could search for <*.app> to get the right path
    #[cfg(target_os = "macos")]
    if extract_path
        .display()
        .to_string()
        .contains("Contents/MacOS")
    {
        return extract_path
            .parent()
            .map(PathBuf::from)
            .ok_or(Error::FailedToDetermineExtractPath)?
            .parent()
            .map(PathBuf::from)
            .ok_or(Error::FailedToDetermineExtractPath);
    }

    Ok(extract_path)
}

impl<'de> Deserialize<'de> for RemoteRelease {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct InnerRemoteRelease {
            #[serde(alias = "name", deserialize_with = "parse_version")]
            version: Version,
            notes: Option<String>,
            pub_date: Option<String>,
            platforms: Option<HashMap<String, ReleaseManifestPlatform>>,
            // dynamic platform response
            url: Option<Url>,
            signature: Option<String>,
        }

        let release = InnerRemoteRelease::deserialize(deserializer)?;

        let pub_date = if let Some(date) = release.pub_date {
            Some(
                OffsetDateTime::parse(&date, &time::format_description::well_known::Rfc3339)
                    .map_err(|e| DeError::custom(format!("invalid value for `pub_date`: {e}")))?,
            )
        } else {
            None
        };

        Ok(RemoteRelease {
            version: release.version,
            notes: release.notes,
            pub_date,
            data: if let Some(platforms) = release.platforms {
                RemoteReleaseInner::Static { platforms }
            } else {
                RemoteReleaseInner::Dynamic(ReleaseManifestPlatform {
                    url: release.url.ok_or_else(|| {
                        DeError::custom("the `url` field was not set on the updater response")
                    })?,
                    signature: release.signature.ok_or_else(|| {
                        DeError::custom("the `signature` field was not set on the updater response")
                    })?,
                })
            },
        })
    }
}

fn installer_for_bundle_type(bundle: Option<BundleType>) -> Option<Installer> {
    match bundle? {
        BundleType::Deb => Some(Installer::Deb),
        BundleType::Rpm => Some(Installer::Rpm),
        BundleType::AppImage => Some(Installer::AppImage),
        BundleType::Msi => Some(Installer::Msi),
        BundleType::Nsis => Some(Installer::Nsis),
        BundleType::App => Some(Installer::App), // App is also returned for Dmg type
        _ => None,
    }
}

fn parse_version<'de, D>(deserializer: D) -> std::result::Result<Version, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let str = String::deserialize(deserializer)?;

    Version::from_str(str.trim_start_matches('v')).map_err(serde::de::Error::custom)
}

// Validate signature
fn verify_signature(
    data: &[u8],
    release_signature: &str,
    pub_key: &str,
    announced_version: &str,
    require_signed_version: bool,
) -> Result<()> {
    // we need to convert the pub key
    let pub_key_decoded = base64_to_string(pub_key)?;
    let public_key = PublicKey::decode(&pub_key_decoded)?;
    let signature_base64_decoded = base64_to_string(release_signature)?;
    let signature = Signature::decode(&signature_base64_decoded)?;

    // Validate signature or bail out
    public_key.verify(data, &signature, true)?;

    // Only now is the trusted comment usable: minisign's global signature covers it, and
    // `verify` above is what checks that global signature. Reading it before this point would
    // be trusting attacker controlled data.
    verify_signed_version(
        signature.trusted_comment(),
        announced_version,
        require_signed_version,
    )
}

/// Checks the version the artifact was signed for against the version the update endpoint
/// announced.
///
/// The endpoint response is not signed, so its `version` field on its own does not prove which
/// release the `url` and `signature` actually point at. Comparing it against the signed version
/// is what stops a tampered response from pairing a new version number with an older release.
fn verify_signed_version(
    trusted_comment: &str,
    announced_version: &str,
    require_signed_version: bool,
) -> Result<()> {
    let Some(signed_version) = signed_version(trusted_comment) else {
        // Signatures produced before the Tauri CLI started recording the version carry none, so
        // this can only be enforced when the app opts in. Note that leaving it off means an
        // attacker can bypass the check outright by serving one of those older signatures.
        return if require_signed_version {
            Err(Error::MissingSignedVersion)
        } else {
            Ok(())
        };
    };

    // compare as semver so that equivalent spellings like `1.2.3` and `v1.2.3` match, falling
    // back to a literal comparison for versions that are not valid semver
    let matches = match (
        Version::from_str(signed_version.trim_start_matches('v')),
        Version::from_str(announced_version.trim_start_matches('v')),
    ) {
        (Ok(signed), Ok(announced)) => signed == announced,
        _ => signed_version == announced_version,
    };

    if matches {
        Ok(())
    } else {
        Err(Error::SignedVersionMismatch {
            signed: signed_version.to_string(),
            announced: announced_version.to_string(),
        })
    }
}

/// Reads the `version` field out of a signature's trusted comment, which the Tauri CLI writes as
/// tab separated `key:value` pairs, e.g. `timestamp:1700000000\tfile:app.tar.gz\tversion:1.2.3`.
fn signed_version(trusted_comment: &str) -> Option<&str> {
    trusted_comment
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
}

fn base64_to_string(base64_string: &str) -> Result<String> {
    let decoded_string = &base64::engine::general_purpose::STANDARD.decode(base64_string)?;
    let result = std::str::from_utf8(decoded_string)
        .map_err(|_| Error::SignatureUtf8(base64_string.into()))?
        .to_string();
    Ok(result)
}

#[cfg(windows)]
fn encode_wide(string: impl AsRef<OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    string
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Converts a failed `ShellExecuteW` return value (`<= 32`) into an error.
///
/// `ShellExecuteW` reports failures through its return value, not reliably through
/// `GetLastError`.
#[cfg(windows)]
fn shell_execute_error(code: isize) -> std::io::Error {
    use std::io::{Error, ErrorKind};
    use windows_sys::Win32::{
        Foundation::ERROR_BAD_FORMAT,
        UI::Shell::{
            SE_ERR_ACCESSDENIED, SE_ERR_ASSOCINCOMPLETE, SE_ERR_DDEBUSY, SE_ERR_DDEFAIL,
            SE_ERR_DDETIMEOUT, SE_ERR_DLLNOTFOUND, SE_ERR_FNF, SE_ERR_NOASSOC, SE_ERR_OOM,
            SE_ERR_PNF, SE_ERR_SHARE,
        },
    };

    let Ok(error) = u32::try_from(code) else {
        return Error::other(format!("ShellExecuteW failed with code {code}"));
    };

    match error {
        0 => Error::new(
            ErrorKind::OutOfMemory,
            "the system is out of memory or resources",
        ),
        // SE_ERR_FNF, SE_ERR_PNF, SE_ERR_ACCESSDENIED (also returned when the user declines the
        // UAC prompt), SE_ERR_OOM and ERROR_BAD_FORMAT share the values of the Win32 error codes
        SE_ERR_FNF | SE_ERR_PNF | SE_ERR_ACCESSDENIED | SE_ERR_OOM | ERROR_BAD_FORMAT => {
            Error::from_raw_os_error(error as i32)
        }
        SE_ERR_SHARE => Error::other("a sharing violation occurred"),
        SE_ERR_ASSOCINCOMPLETE | SE_ERR_NOASSOC => {
            Error::other("no application is associated with the installer")
        }
        SE_ERR_DDETIMEOUT | SE_ERR_DDEFAIL | SE_ERR_DDEBUSY => {
            Error::other("the DDE transaction failed")
        }
        SE_ERR_DLLNOTFOUND => Error::other("the specified DLL was not found"),
        _ => Error::other(format!("ShellExecuteW failed with code {code}")),
    }
}

// CodeNomad: a failed ShellExecuteW must not release persistence ownership.
#[cfg(windows)]
fn finish_windows_launch(result: isize, on_before_exit: impl FnOnce()) -> Result<()> {
    if result <= 32 {
        return Err(crate::Error::Io(shell_execute_error(result)));
    }
    on_before_exit();
    Ok(())
}

#[cfg(all(test, windows))]
mod windows_launch_tests {
    use super::finish_windows_launch;
    use std::cell::Cell;

    #[test]
    fn failed_launch_preserves_ownership_and_success_releases_once() {
        let releases = Cell::new(0);
        for result in [0, 2, 5, 31, 32] {
            assert!(finish_windows_launch(result, || releases.set(releases.get() + 1)).is_err());
        }
        assert_eq!(releases.get(), 0);
        finish_windows_launch(33, || releases.set(releases.get() + 1)).unwrap();
        assert_eq!(releases.get(), 1);
    }
}

#[cfg(windows)]
trait PathExt {
    fn wrap_in_quotes(&self) -> Self;
}

#[cfg(windows)]
impl PathExt for PathBuf {
    fn wrap_in_quotes(&self) -> Self {
        let mut msi_path = OsString::from("\"");
        msi_path.push(self.as_os_str());
        msi_path.push("\"");
        PathBuf::from(msi_path)
    }
}

// adapted from https://github.com/rust-lang/rust/blob/1c047506f94cd2d05228eb992b0a6bbed1942349/library/std/src/sys/args/windows.rs#L174
#[cfg(windows)]
fn escape_nsis_current_exe_arg(arg: impl AsRef<OsStr>) -> OsString {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    let arg = arg.as_ref();
    let mut cmd: Vec<u16> = Vec::new();

    // compared to std we additionally escape `/` so that nsis won't interpret them as a beginning of an nsis argument.
    let quote = arg
        .as_encoded_bytes()
        .iter()
        .any(|c| *c == b' ' || *c == b'\t' || *c == b'/')
        || arg.is_empty();
    let escape = true;
    if quote {
        cmd.push('"' as u16);
    }
    let mut backslashes: usize = 0;
    for x in arg.encode_wide() {
        if escape {
            if x == '\\' as u16 {
                backslashes += 1;
            } else {
                if x == '"' as u16 {
                    // Add n+1 backslashes to total 2n+1 before internal '"'.
                    cmd.extend((0..=backslashes).map(|_| '\\' as u16));
                }
                backslashes = 0;
            }
        }
        cmd.push(x);
    }
    if quote {
        // Add n backslashes to total 2n before ending '"'.
        cmd.extend((0..backslashes).map(|_| '\\' as u16));
        cmd.push('"' as u16);
    }
    OsString::from_wide(&cmd)
}

#[cfg(windows)]
fn escape_msi_property_arg(arg: impl AsRef<OsStr>) -> String {
    let mut arg = arg.as_ref().to_string_lossy().to_string();

    // Otherwise this argument will get lost in ShellExecute
    if arg.is_empty() {
        return "\"\"\"\"".to_string();
    } else if !arg.contains(' ') && !arg.contains('"') {
        return arg;
    }

    if arg.contains('"') {
        arg = arg.replace('"', r#""""""#);
    }

    if arg.starts_with('-') {
        if let Some((a1, a2)) = arg.split_once('=') {
            format!("{a1}=\"\"{a2}\"\"")
        } else {
            format!("\"\"{arg}\"\"")
        }
    } else {
        format!("\"\"{arg}\"\"")
    }
}

#[cfg(test)]
mod offline_tests {
    use super::*;
    use serde_json::{Value, json};

    // A throwaway key pair generated with `tauri signer generate`, and the signature of the
    // payload `test` made with `tauri signer sign --app-version 2.0.0`.
    const PUBLIC_KEY: &str = "untrusted comment: minisign public key: A49EF4746FA6E6D7\nRWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe";
    const SIGNATURE: &str = "untrusted comment: signature from tauri secret key\nRUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=\ntrusted comment: timestamp:1791649051\tfile:payload\tversion:2.0.0\nDDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA==";
    // The public `test` payload vector from minisign-verify, signed without a version.
    const UNVERSIONED_PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const UNVERSIONED_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==";

    fn encode(value: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(value)
    }

    fn builder() -> UpdaterBuilder {
        let app = tauri::test::mock_app();
        let config = Config {
            pubkey: encode(PUBLIC_KEY),
            ..Default::default()
        };
        let mut builder = UpdaterBuilder::new(app.handle(), config)
            .target("test-target")
            .executable_path("runtime-path/app")
            .timeout(Duration::from_secs(30))
            .no_proxy()
            .configure_client(|_| panic!("unexpected network request"))
            .endpoints(vec!["https://example.invalid/update".parse().unwrap()])
            .unwrap();
        builder.current_version = Version::new(1, 0, 0);
        builder
    }

    fn updater() -> Updater {
        builder().build().unwrap()
    }

    fn manifest() -> Value {
        json!({
            "version": "2.0.0",
            "notes": "Cached release notes",
            "pub_date": "2025-01-01T00:00:00Z",
            "platforms": {
                "test-target": {
                    "url": "https://example.invalid/package",
                    "signature": encode(SIGNATURE)
                }
            }
        })
    }

    #[test]
    fn restores_release_metadata_with_runtime_context() {
        let updater = builder()
            .header("x-test", "runtime")
            .unwrap()
            .build()
            .unwrap();
        let mut metadata = manifest();
        metadata["extract_path"] = json!("untrusted-path");
        metadata["config"] = json!({ "pubkey": "untrusted-key" });
        let update = updater.restore_update(metadata.clone()).unwrap().unwrap();

        assert_eq!(update.raw_json, metadata);
        assert_eq!(update.current_version, "1.0.0");
        assert_eq!(update.version, "2.0.0");
        assert_eq!(update.body.as_deref(), Some("Cached release notes"));
        assert!(update.date.is_some());
        assert_eq!(update.target, "test-target");
        assert_eq!(update.extract_path, updater.extract_path);
        assert_eq!(update.context.config.pubkey, updater.context.config.pubkey);
        assert_eq!(update.headers, updater.headers);
        assert!(update.no_proxy);
        assert!(update.timeout.is_none());
        update.verify(b"test").unwrap();
    }

    #[test]
    fn restores_dynamic_manifests() {
        let update = updater()
            .restore_update(json!({
                "version": "2.0.0",
                "url": "https://example.invalid/dynamic-package",
                "signature": encode(SIGNATURE)
            }))
            .unwrap()
            .unwrap();
        assert_eq!(
            update.download_url.as_str(),
            "https://example.invalid/dynamic-package"
        );
        update.verify(b"test").unwrap();
    }

    #[test]
    fn respects_default_and_custom_version_comparators() {
        let mut updater = updater();
        for version in ["0.9.0", "1.0.0"] {
            let mut metadata = manifest();
            metadata["version"] = json!(version);
            assert!(updater.restore_update(metadata).unwrap().is_none());
        }
        updater.version_comparator = Some(Arc::new(|_, _| false));
        assert!(updater.restore_update(manifest()).unwrap().is_none());
        updater.version_comparator = Some(Arc::new(|current, release| release.version != current));
        let mut metadata = manifest();
        metadata["version"] = json!("0.9.0");
        assert!(updater.restore_update(metadata).unwrap().is_some());
    }

    #[test]
    fn stale_release_without_this_target_is_not_an_update() {
        let mut metadata = manifest();
        metadata["version"] = json!("0.9.0");
        metadata["platforms"] = json!({ "other-target": metadata["platforms"]["test-target"] });
        assert!(updater().restore_update(metadata).unwrap().is_none());
    }

    #[test]
    fn rejects_malformed_and_incompatible_manifests() {
        let updater = updater();
        assert!(updater.restore_update(json!({})).is_err());
        let mut metadata = manifest();
        metadata["platforms"] = json!({});
        assert!(matches!(
            updater.restore_update(metadata),
            Err(Error::TargetNotFound(_))
        ));
        let mut metadata = manifest();
        metadata["version"] = json!("not-a-version");
        assert!(updater.restore_update(metadata).is_err());
    }

    #[test]
    fn verifies_cached_bytes_and_rejects_tampering() {
        let mut update = updater().restore_update(manifest()).unwrap().unwrap();
        update.verify(b"test").unwrap();
        assert!(update.verify(b"tampered").is_err());
        update.signature = encode(&SIGNATURE.replace("file:payload", "file:other"));
        assert!(update.verify(b"test").is_err());
        update.signature = "invalid signature".into();
        assert!(update.verify(b"test").is_err());
        update.signature = encode(SIGNATURE);
        update.context.config.pubkey = encode(&PUBLIC_KEY.replace("RWTX", "RWTY"));
        assert!(update.verify(b"test").is_err());
    }

    #[test]
    fn install_rejects_bytes_that_do_not_match_the_signature() {
        let update = updater().restore_update(manifest()).unwrap().unwrap();
        assert!(matches!(
            update.install(b"tampered"),
            Err(Error::Minisign(_))
        ));
    }

    #[test]
    fn restored_updates_require_a_signed_version() {
        let mut builder = builder().pubkey(encode(UNVERSIONED_PUBLIC_KEY));
        builder.context.config.require_signed_version = false;
        let updater = builder.build().unwrap();
        let mut metadata = manifest();
        metadata["platforms"]["test-target"]["signature"] = json!(encode(UNVERSIONED_SIGNATURE));
        metadata["config"] = json!({ "requireSignedVersion": false });
        let update = updater.restore_update(metadata).unwrap().unwrap();
        assert!(matches!(
            update.verify(b"test"),
            Err(Error::MissingSignedVersion)
        ));
        assert!(matches!(
            update.install(b"test"),
            Err(Error::MissingSignedVersion)
        ));
    }

    #[test]
    fn restored_updates_reject_a_version_the_package_was_not_signed_for() {
        let mut metadata = manifest();
        metadata["version"] = json!("3.0.0");
        let update = updater().restore_update(metadata).unwrap().unwrap();
        assert!(matches!(
            update.verify(b"test"),
            Err(Error::SignedVersionMismatch { .. })
        ));
    }

    #[test]
    fn online_and_restored_updates_use_the_same_metadata() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let metadata = manifest();
        let response = metadata.to_string();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&mut socket);
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
        });
        let mut updater = updater();
        updater.context.configure_client = None;
        updater.endpoints = vec![format!("http://{address}").parse().unwrap()];
        let online = tauri::async_runtime::block_on(updater.check())
            .unwrap()
            .unwrap();
        server.join().unwrap();
        let restored = updater
            .restore_update(online.raw_json.clone())
            .unwrap()
            .unwrap();
        assert_eq!(restored.raw_json, metadata);
        assert_eq!(restored.version, online.version);
        assert_eq!(restored.current_version, online.current_version);
        assert_eq!(restored.target, online.target);
        assert_eq!(restored.download_url, online.download_url);
        assert_eq!(restored.signature, online.signature);
        assert_eq!(restored.extract_path, online.extract_path);
        assert_eq!(restored.timeout, online.timeout);
        assert!(!online.context.config.require_signed_version);
        assert!(restored.context.config.require_signed_version);
    }

    #[cfg(target_os = "linux")]
    const INSTALLED_APPIMAGE: &[u8] = b"\x7fELF installed AppImage";

    /// An update for an AppImage installed in a fresh directory.
    #[cfg(target_os = "linux")]
    fn appimage_update() -> (tempfile::TempDir, PathBuf, Update) {
        let dir = tempfile::tempdir().unwrap();
        let appimage = dir.path().join("app.AppImage");
        std::fs::write(&appimage, INSTALLED_APPIMAGE).unwrap();
        let update = builder()
            .executable_path(&appimage)
            .build()
            .unwrap()
            .restore_update(manifest())
            .unwrap()
            .unwrap();
        (dir, appimage, update)
    }

    /// The smallest buffer `infer` recognizes as an ELF executable: a full ELF header.
    #[cfg(target_os = "linux")]
    fn new_appimage() -> Vec<u8> {
        let mut appimage = b"\x7fELF new AppImage".to_vec();
        appimage.resize(64, 0);
        appimage
    }

    #[cfg(all(target_os = "linux", feature = "zip"))]
    fn compressed_appimage(name: &str, contents: &[u8]) -> Vec<u8> {
        let mut archive = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::default(),
        ));
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        archive.append_data(&mut header, name, contents).unwrap();
        archive.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn appimage_install_rejects_a_payload_that_is_not_an_appimage() {
        let (_dir, appimage, update) = appimage_update();
        assert!(matches!(
            update.install_appimage(b"not an AppImage"),
            Err(Error::InvalidUpdaterFormat)
        ));
        assert_eq!(std::fs::read(&appimage).unwrap(), INSTALLED_APPIMAGE);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn appimage_install_writes_an_appimage_payload() {
        use std::os::unix::fs::PermissionsExt;

        let (_dir, appimage, update) = appimage_update();
        std::fs::set_permissions(&appimage, std::fs::Permissions::from_mode(0o755)).unwrap();
        update.install_appimage(&new_appimage()).unwrap();
        assert_eq!(std::fs::read(&appimage).unwrap(), new_appimage());
        assert_eq!(
            std::fs::metadata(&appimage).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[test]
    #[cfg(all(target_os = "linux", feature = "zip"))]
    fn appimage_install_extracts_a_compressed_appimage() {
        let (_dir, appimage, update) = appimage_update();
        update
            .install_appimage(&compressed_appimage("app.AppImage", &new_appimage()))
            .unwrap();
        assert_eq!(std::fs::read(&appimage).unwrap(), new_appimage());
    }

    #[test]
    #[cfg(all(target_os = "linux", feature = "zip"))]
    fn appimage_install_restores_the_app_when_the_archive_has_no_appimage() {
        let (_dir, appimage, update) = appimage_update();
        assert!(matches!(
            update.install_appimage(&compressed_appimage("readme.txt", b"hello")),
            Err(Error::BinaryNotFoundInArchive)
        ));
        assert_eq!(std::fs::read(&appimage).unwrap(), INSTALLED_APPIMAGE);
    }

    #[test]
    #[cfg(all(target_os = "linux", not(feature = "zip")))]
    fn appimage_install_rejects_a_compressed_appimage_without_the_zip_feature() {
        let (_dir, appimage, update) = appimage_update();
        // the gzip magic, which is all the check looks at
        assert!(matches!(
            update.install_appimage(b"\x1f\x8b\x08\x00 compressed AppImage"),
            Err(Error::InvalidUpdaterFormat)
        ));
        assert_eq!(std::fs::read(&appimage).unwrap(), INSTALLED_APPIMAGE);
    }
}

#[cfg(test)]
mod tests {
    use super::{signed_version, verify_signed_version};
    use crate::error::Error;

    const CURRENT: &str = "timestamp:1700000000\tfile:app_1.2.3_x64.msi.zip\tversion:1.2.3";
    // signatures produced before the CLI started embedding the version
    const LEGACY: &str = "timestamp:1600000000\tfile:app_1.0.0_x64.msi.zip";

    #[test]
    fn reads_the_signed_version() {
        assert_eq!(signed_version(CURRENT), Some("1.2.3"));
        assert_eq!(signed_version(LEGACY), None);
        // must not match on a field that merely ends in `version:`
        assert_eq!(signed_version("timestamp:1\tfile:app-version:2.zip"), None);
    }

    #[test]
    fn accepts_a_matching_version() {
        assert!(verify_signed_version(CURRENT, "1.2.3", true).is_ok());
        assert!(verify_signed_version(CURRENT, "1.2.3", false).is_ok());
        // the endpoint and the CLI may spell the same version differently
        assert!(verify_signed_version(CURRENT, "v1.2.3", true).is_ok());
    }

    #[test]
    fn rejects_a_version_the_artifact_was_not_signed_for() {
        // the rollback the flag exists to stop: an old artifact announced as a new version
        let err = verify_signed_version(CURRENT, "9.9.9", false).unwrap_err();
        assert!(
            matches!(err, Error::SignedVersionMismatch { ref signed, ref announced }
                if signed == "1.2.3" && announced == "9.9.9"),
            "unexpected error: {err}"
        );
        // rejected regardless of whether the app opted in, since the signature does say
        // which version it covers
        assert!(verify_signed_version(CURRENT, "9.9.9", true).is_err());
        assert!(verify_signed_version(CURRENT, "1.2.4", true).is_err());
    }

    #[test]
    fn only_requires_a_signed_version_when_configured() {
        assert!(verify_signed_version(LEGACY, "9.9.9", false).is_ok());
        assert!(matches!(
            verify_signed_version(LEGACY, "9.9.9", true).unwrap_err(),
            Error::MissingSignedVersion
        ));
    }

    #[test]
    fn compares_non_semver_versions_literally() {
        let comment = "timestamp:1700000000\tfile:app.zip\tversion:2024-01-01";
        assert!(verify_signed_version(comment, "2024-01-01", true).is_ok());
        assert!(verify_signed_version(comment, "2024-01-02", true).is_err());
    }

    #[test]
    fn replace_bundle_moves_the_staged_bundle_into_place() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("App.app");
        let staged = dir.path().join("staged");
        let backup = dir.path().join("backup");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("version"), "old").unwrap();
        std::fs::create_dir(&staged).unwrap();
        std::fs::write(staged.join("version"), "new").unwrap();

        super::replace_bundle(&target, &staged, &backup).unwrap();

        assert_eq!(
            std::fs::read_to_string(target.join("version")).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(backup.join("version")).unwrap(),
            "old"
        );
        assert!(!staged.exists());
    }

    #[cfg(target_os = "macos")]
    fn is_apfs(path: &std::path::Path) -> bool {
        use std::os::unix::ffi::OsStrExt;

        let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
        // SAFETY: `path` is NUL-terminated and `stat` is a valid `statfs` to write to.
        assert_eq!(unsafe { libc::statfs(path.as_ptr(), &mut stat) }, 0);
        // SAFETY: `f_fstypename` is a NUL-terminated string filled in by `statfs`.
        let name = unsafe { std::ffi::CStr::from_ptr(stat.f_fstypename.as_ptr()) };
        name.to_bytes() == b"apfs"
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn swap_bundle_exchanges_the_two_bundles_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("App.app");
        let staged = dir.path().join("staged");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("version"), "old").unwrap();
        std::fs::create_dir(&staged).unwrap();
        std::fs::write(staged.join("version"), "new").unwrap();

        // A temp dir on a file system without swap support proves nothing here, but on
        // APFS the swap has to work: the install would otherwise always fall back.
        if !is_apfs(dir.path()) {
            return;
        }
        super::swap_bundle(&target, &staged).unwrap();

        assert_eq!(
            std::fs::read_to_string(target.join("version")).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(staged.join("version")).unwrap(),
            "old"
        );
    }

    #[test]
    fn replace_bundle_restores_the_current_bundle_when_the_move_fails() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("App.app");
        let backup = dir.path().join("backup");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("version"), "old").unwrap();
        let missing = dir.path().join("missing");

        let err = super::replace_bundle(&target, &missing, &backup).unwrap_err();

        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
        assert_eq!(
            std::fs::read_to_string(target.join("version")).unwrap(),
            "old"
        );
        assert!(!backup.exists());
    }

    /// A directory whose name `sh` and AppleScript would both misread unquoted.
    #[cfg(target_os = "macos")]
    fn hostile_dir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("it's \"a\" \\ $(touch pwned) `dir`\n")
            .tempdir()
            .unwrap()
    }

    #[cfg(target_os = "macos")]
    fn assert_privileged_install_command_moved(dir: &std::path::Path) {
        let target = dir.join("Bob's \"App\".app");
        assert_eq!(
            std::fs::read_to_string(target.join("version")).unwrap(),
            "new"
        );
        assert!(!dir.join("staged").exists());
        assert!(!dir.join("backup").exists());
        assert!(!dir.join("pwned").exists());
    }

    #[cfg(target_os = "macos")]
    fn stage_privileged_install(dir: &std::path::Path) -> String {
        let target = dir.join("Bob's \"App\".app");
        let staged = dir.join("staged");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("version"), "old").unwrap();
        std::fs::create_dir(&staged).unwrap();
        std::fs::write(staged.join("version"), "new").unwrap();
        super::privileged_install_command(&target, &staged, &dir.join("backup"))
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn privileged_install_command_quotes_every_path() {
        let dir = hostile_dir();
        let command = stage_privileged_install(dir.path());

        let status = std::process::Command::new("sh")
            .arg("-c")
            .arg(&command)
            .current_dir(dir.path())
            .status()
            .unwrap();

        assert!(status.success());
        assert_privileged_install_command_moved(dir.path());
    }

    /// The command the install runs, wrapped the way it is handed to AppleScript, only without
    /// `with administrator privileges` so it runs without a prompt.
    #[test]
    #[cfg(target_os = "macos")]
    fn privileged_install_script_quotes_every_path() {
        let dir = hostile_dir();
        let command = stage_privileged_install(dir.path());

        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg(format!(
                "do shell script {}",
                super::applescript_string(&command)
            ))
            .current_dir(dir.path())
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_privileged_install_command_moved(dir.path());
    }

    /// The privileged install swaps the bundles where the file system can, so on APFS it
    /// never touches the backup: one in a directory that does not exist must not matter.
    #[test]
    #[cfg(target_os = "macos")]
    fn privileged_install_command_swaps_the_bundles() {
        let dir = tempfile::tempdir().unwrap();
        if !is_apfs(dir.path()) {
            return;
        }
        let target = dir.path().join("App.app");
        let staged = dir.path().join("staged");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("version"), "old").unwrap();
        std::fs::create_dir(&staged).unwrap();
        std::fs::write(staged.join("version"), "new").unwrap();
        let backup = dir.path().join("missing").join("backup");

        let status = std::process::Command::new("sh")
            .arg("-c")
            .arg(super::privileged_install_command(&target, &staged, &backup))
            .status()
            .unwrap();

        assert!(status.success());
        assert_eq!(
            std::fs::read_to_string(target.join("version")).unwrap(),
            "new"
        );
        assert!(!staged.exists());
    }

    #[test]
    fn keeps_the_backup_when_the_previous_app_was_not_restored() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("App.app");
        let backup_dir = tempfile::tempdir_in(dir.path()).unwrap();
        let backup_dir_path = backup_dir.path().to_path_buf();
        let backup = backup_dir_path.join("current_app");
        std::fs::create_dir(&backup).unwrap();
        std::fs::write(backup.join("version"), "old").unwrap();

        let kept = super::keep_backup_if_not_restored(&target, backup_dir, &backup, None);

        let expected = dir.path().join("App (previous version).app");
        assert_eq!(kept.as_deref(), Some(expected.as_path()));
        assert_eq!(
            std::fs::read_to_string(expected.join("version")).unwrap(),
            "old"
        );
        assert!(!backup_dir_path.exists());
    }

    #[test]
    fn moves_the_backup_to_the_fallback_dir_when_it_cannot_go_next_to_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("App.app");
        std::fs::write(dir.path().join("App (previous version).app"), "other").unwrap();
        let backup_dir = tempfile::tempdir_in(dir.path()).unwrap();
        let backup = backup_dir.path().join("current_app");
        std::fs::create_dir(&backup).unwrap();
        std::fs::write(backup.join("version"), "old").unwrap();
        let fallback = tempfile::tempdir_in(dir.path()).unwrap();

        let kept =
            super::keep_backup_if_not_restored(&target, backup_dir, &backup, Some(fallback.path()));

        let expected = fallback.path().join("App (previous version).app");
        assert_eq!(kept.as_deref(), Some(expected.as_path()));
        assert_eq!(
            std::fs::read_to_string(expected.join("version")).unwrap(),
            "old"
        );
    }

    #[test]
    fn keeps_the_backup_in_place_when_it_cannot_be_moved() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("App.app");
        // A file where the backup would go next to the app, which must not be replaced
        std::fs::write(dir.path().join("App (previous version).app"), "other").unwrap();
        let backup_dir = tempfile::tempdir_in(dir.path()).unwrap();
        let backup_dir_path = backup_dir.path().to_path_buf();
        let backup = backup_dir_path.join("current_app");
        std::fs::create_dir(&backup).unwrap();
        std::fs::write(backup.join("version"), "old").unwrap();
        let missing = dir.path().join("missing");

        let kept = super::keep_backup_if_not_restored(&target, backup_dir, &backup, Some(&missing));

        assert_eq!(kept.as_deref(), Some(backup.as_path()));
        assert_eq!(
            std::fs::read_to_string(backup.join("version")).unwrap(),
            "old"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("App (previous version).app")).unwrap(),
            "other"
        );
    }

    #[test]
    fn drops_the_backup_when_the_previous_app_is_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("App.app");
        std::fs::create_dir(&target).unwrap();
        let backup_dir = tempfile::tempdir_in(dir.path()).unwrap();
        let backup_dir_path = backup_dir.path().to_path_buf();
        let backup = backup_dir_path.join("current_app");
        std::fs::create_dir(&backup).unwrap();

        assert!(super::keep_backup_if_not_restored(&target, backup_dir, &backup, None).is_none());
        assert!(!backup_dir_path.exists());
    }

    #[test]
    #[cfg(windows)]
    fn it_wraps_correctly() {
        use super::PathExt;
        use std::path::PathBuf;

        assert_eq!(
            PathBuf::from("C:\\Users\\Some User\\AppData\\tauri-example.exe").wrap_in_quotes(),
            PathBuf::from("\"C:\\Users\\Some User\\AppData\\tauri-example.exe\"")
        )
    }

    #[test]
    #[cfg(windows)]
    fn it_escapes_correctly_for_msi() {
        use crate::updater::escape_msi_property_arg;

        // Explanation for quotes:
        // The output of escape_msi_property_args() will be used in `LAUNCHAPPARGS=\"{HERE}\"`. This is the first quote level.
        // To escape a quotation mark we use a second quotation mark, so "" is interpreted as " later.
        // This means that the escaped strings can't ever have a single quotation mark!
        // Now there are 3 major things to look out for to not break the msiexec call:
        //   1) Wrap spaces in quotation marks, otherwise it will be interpreted as the end of the msiexec argument.
        //   2) Escape escaping quotation marks, otherwise they will either end the msiexec argument or be ignored.
        //   3) Escape emtpy args in quotation marks, otherwise the argument will get lost.
        let cases = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "some space",                     // This simulates `./my-app "some string"`.
            "--arg value", // -> This simulates `./my-app "--arg value"`. Same as above but it triggers the startsWith(`-`) logic.
            "--arg=unwrapped space", // `./my-app --arg="unwrapped space"`
            "--arg=\"wrapped\"", // `./my-app --args=""wrapped""`
            "--arg=\"wrapped space\"", // `./my-app --args=""wrapped space""`
            "--arg=midword\"wrapped space\"", // `./my-app --args=midword""wrapped""`
            "",            // `./my-app '""'`
        ];
        let cases_escaped = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "\"\"some space\"\"",
            "\"\"--arg value\"\"",
            "--arg=\"\"unwrapped space\"\"",
            r#"--arg=""""""wrapped"""""""#,
            r#"--arg=""""""wrapped space"""""""#,
            r#"--arg=""midword""""wrapped space"""""""#,
            "\"\"\"\"",
        ];

        // Just to be sure we didn't mess that up
        assert_eq!(cases.len(), cases_escaped.len());

        for (orig, escaped) in cases.iter().zip(cases_escaped) {
            assert_eq!(escape_msi_property_arg(orig), escaped);
        }
    }

    #[test]
    #[cfg(windows)]
    fn it_escapes_correctly_for_nsis() {
        use crate::updater::escape_nsis_current_exe_arg;
        use std::ffi::OsStr;

        let cases = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "some space",                     // This simulates `./my-app "some string"`.
            "--arg value", // -> This simulates `./my-app "--arg value"`. Same as above but it triggers the startsWith(`-`) logic.
            "--arg=unwrapped space", // `./my-app --arg="unwrapped space"`
            "--arg=\"wrapped\"", // `./my-app --args=""wrapped""`
            "--arg=\"wrapped space\"", // `./my-app --args=""wrapped space""`
            "--arg=midword\"wrapped space\"", // `./my-app --args=midword""wrapped""`
            "",            // `./my-app '""'`
        ];
        // Note: These may not be the results we actually want (monitor this!).
        // We only make sure the implementation doesn't unintentionally change.
        let cases_escaped = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "\"some space\"",
            "\"--arg value\"",
            "\"--arg=unwrapped space\"",
            "--arg=\\\"wrapped\\\"",
            "\"--arg=\\\"wrapped space\\\"\"",
            "\"--arg=midword\\\"wrapped space\\\"\"",
            "\"\"",
        ];

        // Just to be sure we didn't mess that up
        assert_eq!(cases.len(), cases_escaped.len());

        for (orig, escaped) in cases.iter().zip(cases_escaped) {
            assert_eq!(escape_nsis_current_exe_arg(OsStr::new(orig)), escaped);
        }
    }
}
