//! Host network interface discovery and remote URL ordering (`server/network-addresses.ts`,
//! `index.ts` wildcard binding).
use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
};

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InterfaceAddress {
    pub ip: IpAddr,
    pub internal: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkAddress {
    pub ip: String,
    pub family: &'static str,
    pub scope: &'static str,
    pub remote_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedRemote {
    pub primary_url: String,
    pub addresses: Vec<NetworkAddress>,
    pub listener_origins: Vec<String>,
    pub direct_origins: Vec<String>,
}

pub fn format_origin(host: &str, port: u16) -> String {
    if port == 443 { format!("https://{host}") } else { format!("https://{host}:{port}") }
}

fn format_ip_host(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => format!("[{v6}]"),
    }
}

fn is_link_local_v6(v6: Ipv6Addr) -> bool {
    (v6.segments()[0] & 0xffc0) == 0xfe80
}

fn user_visible_priority(ip: IpAddr) -> u8 {
    match ip {
        IpAddr::V4(v4) if v4.is_private() => 0,
        IpAddr::V4(v4) if v4.is_link_local() => 2,
        _ => 1,
    }
}

/// Resolves remote URLs and accepted HTTPS origins for a listener bound to `bind_ip:port`.
/// When `bind_ip` is `::`, IPv4 interface addresses are included only if `dual_stack` is active.
pub fn resolve_remote(bind_ip: IpAddr, port: u16, dual_stack: bool, system_ips: &[InterfaceAddress]) -> ResolvedRemote {
    let bind_ip = bind_ip.to_canonical();
    let mut seen = HashSet::new();
    let mut all_ips: Vec<(IpAddr, &'static str)> = Vec::new();
    let mut push = |raw: IpAddr, scope: &'static str| {
        let ip = raw.to_canonical();
        if ip.is_unspecified() || matches!(ip, IpAddr::V6(v6) if is_link_local_v6(v6)) {
            return;
        }
        if seen.insert(ip) {
            all_ips.push((ip, scope));
        }
    };

    if bind_ip.is_unspecified() {
        for &entry in system_ips {
            let ip = entry.ip.to_canonical();
            if bind_ip.is_ipv4() && !ip.is_ipv4() {
                continue;
            }
            if bind_ip.is_ipv6() && ip.is_ipv4() && !dual_stack {
                continue;
            }
            let scope = if entry.internal || ip.is_loopback() { "loopback" } else { "external" };
            push(ip, scope);
        }
    } else {
        let scope = if bind_ip.is_loopback() { "loopback" } else { "external" };
        push(bind_ip, scope);
    }

    // External first, then loopback, preserving discovery order within each group.
    all_ips.sort_by_key(|&(_, scope)| if scope == "external" { 0u8 } else { 1u8 });
    let to_entry = |&(ip, scope): &(IpAddr, &'static str)| NetworkAddress {
        ip: ip.to_string(),
        family: if ip.is_ipv6() { "ipv6" } else { "ipv4" },
        scope,
        remote_url: format_origin(&format_ip_host(ip), port),
    };

    if !bind_ip.is_unspecified() {
        let is_v4_loopback = bind_ip == IpAddr::V4(Ipv4Addr::LOCALHOST);
        let host = if is_v4_loopback { "localhost".to_owned() } else { format_ip_host(bind_ip) };
        let origin = format_origin(&host, port);
        let mut listener_origins = vec![origin.clone()];
        if is_v4_loopback {
            listener_origins.push(format_origin("127.0.0.1", port));
        }
        let direct_origins = if bind_ip.is_loopback() { Vec::new() } else { vec![origin.clone()] };
        return ResolvedRemote {
            primary_url: origin,
            addresses: all_ips.iter().map(to_entry).collect(),
            listener_origins,
            direct_origins,
        };
    }

    let mut external: Vec<(IpAddr, &'static str)> =
        all_ips.iter().copied().filter(|&(_, scope)| scope == "external").collect();
    external.sort_by_key(|&(ip, _)| user_visible_priority(ip));
    let user_visible: Vec<NetworkAddress> = external.iter().map(to_entry).collect();
    let direct_origins: Vec<String> = user_visible.iter().map(|a| a.remote_url.clone()).collect();
    let fallback_host = if bind_ip.is_ipv4() { "127.0.0.1" } else { "[::1]" };
    let primary_url =
        user_visible.first().map(|a| a.remote_url.clone()).unwrap_or_else(|| format_origin(fallback_host, port));

    let addresses = if user_visible.is_empty() { all_ips.iter().map(to_entry).collect() } else { user_visible };
    let mut listener_origins: Vec<String> = addresses.iter().map(|a| a.remote_url.clone()).collect();
    let loopback_hosts: &[&str] = if bind_ip.is_ipv4() {
        &["localhost", "127.0.0.1"]
    } else if dual_stack {
        &["localhost", "127.0.0.1", "[::1]"]
    } else {
        &["localhost", "[::1]"]
    };
    for host in loopback_hosts {
        let origin = format_origin(host, port);
        if !listener_origins.contains(&origin) {
            listener_origins.push(origin);
        }
    }
    ResolvedRemote { primary_url, addresses, listener_origins, direct_origins }
}

/// Enumerates unicast IP addresses of active host interfaces (`os.networkInterfaces()`).
pub fn host_interface_ips() -> Vec<InterfaceAddress> {
    #[cfg(windows)]
    {
        windows_interface_ips()
    }
    #[cfg(unix)]
    {
        unix_interface_ips()
    }
    #[cfg(not(any(windows, unix)))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
fn windows_interface_ips() -> Vec<InterfaceAddress> {
    use windows_sys::Win32::{
        Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_SUCCESS},
        NetworkManagement::{
            IpHelper::{
                GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_FRIENDLY_NAME, GAA_FLAG_SKIP_MULTICAST,
                GetAdaptersAddresses, IF_TYPE_SOFTWARE_LOOPBACK, IP_ADAPTER_ADDRESSES_LH,
            },
            Ndis::IfOperStatusUp,
        },
        Networking::WinSock::{AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR, SOCKADDR_IN, SOCKADDR_IN6},
    };
    const _: () = assert!(align_of::<u64>() >= align_of::<IP_ADAPTER_ADDRESSES_LH>());
    let flags =
        GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER | GAA_FLAG_SKIP_FRIENDLY_NAME;
    let mut size: u32 = 16 * 1024;
    let mut buffer: Vec<u64> = Vec::new();
    let mut succeeded = false;
    for _ in 0..4 {
        let words = (size as usize).div_ceil(size_of::<u64>());
        buffer.resize(words, 0);
        let mut capacity = u32::try_from(buffer.len().saturating_mul(size_of::<u64>())).unwrap_or(u32::MAX);
        // SAFETY: `buffer` is 8-byte aligned (>= `IP_ADAPTER_ADDRESSES_LH` alignment) with `capacity` bytes.
        let status = unsafe {
            GetAdaptersAddresses(AF_UNSPEC as u32, flags, std::ptr::null(), buffer.as_mut_ptr().cast(), &mut capacity)
        };
        if status == ERROR_SUCCESS {
            succeeded = true;
            break;
        }
        if status != ERROR_BUFFER_OVERFLOW || capacity == 0 {
            return Vec::new();
        }
        size = capacity;
    }
    if !succeeded || buffer.is_empty() {
        return Vec::new();
    }
    let mut ips = Vec::new();
    let mut adapter = buffer.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
    while !adapter.is_null() {
        // SAFETY: `GetAdaptersAddresses` succeeded and populated `buffer` with aligned adapter nodes.
        let current = unsafe { &*adapter };
        if current.OperStatus == IfOperStatusUp {
            let internal = current.IfType == IF_TYPE_SOFTWARE_LOOPBACK;
            let mut unicast = current.FirstUnicastAddress;
            while !unicast.is_null() {
                // SAFETY: `unicast` points to a valid node in `buffer`.
                let entry = unsafe { &*unicast };
                let sa = entry.Address.lpSockaddr;
                if let Ok(sock_len) = usize::try_from(entry.Address.iSockaddrLength)
                    && !sa.is_null()
                    && sock_len >= size_of::<SOCKADDR>()
                {
                    // SAFETY: `sa` is non-null and `sock_len >= size_of::<SOCKADDR>()`.
                    let family = unsafe { std::ptr::read_unaligned(sa).sa_family };
                    if family == AF_INET && sock_len >= size_of::<SOCKADDR_IN>() {
                        // SAFETY: `family == AF_INET` and `sock_len` covers `SOCKADDR_IN`.
                        let addr = unsafe { std::ptr::read_unaligned(sa.cast::<SOCKADDR_IN>()).sin_addr.S_un.S_addr };
                        let ip = IpAddr::V4(Ipv4Addr::from(addr.to_ne_bytes()));
                        ips.push(InterfaceAddress { ip, internal: internal || ip.is_loopback() });
                    } else if family == AF_INET6 && sock_len >= size_of::<SOCKADDR_IN6>() {
                        // SAFETY: `family == AF_INET6` and `sock_len` covers `SOCKADDR_IN6`.
                        let bytes = unsafe { std::ptr::read_unaligned(sa.cast::<SOCKADDR_IN6>()).sin6_addr.u.Byte };
                        let ip = IpAddr::V6(Ipv6Addr::from(bytes));
                        ips.push(InterfaceAddress { ip, internal: internal || ip.is_loopback() });
                    }
                }
                unicast = entry.Next;
            }
        }
        adapter = current.Next;
    }
    ips
}

#[cfg(unix)]
fn unix_interface_ips() -> Vec<InterfaceAddress> {
    struct IfAddrs(*mut libc::ifaddrs);
    impl Drop for IfAddrs {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: pointer returned by `getifaddrs`.
                unsafe { libc::freeifaddrs(self.0) };
            }
        }
    }
    let mut head = std::ptr::null_mut();
    // SAFETY: standard POSIX `getifaddrs`.
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return Vec::new();
    }
    let _guard = IfAddrs(head);
    let mut ips = Vec::new();
    let mut cursor = head;
    while !cursor.is_null() {
        // SAFETY: valid node in the linked list owned by `_guard`.
        let entry = unsafe { &*cursor };
        let flags = entry.ifa_flags;
        let active = (flags & libc::IFF_UP as u32) != 0 && (flags & libc::IFF_RUNNING as u32) != 0;
        let internal = (flags & libc::IFF_LOOPBACK as u32) != 0;
        if active && !entry.ifa_addr.is_null() {
            // SAFETY: `ifa_addr` is non-null.
            let family = unsafe { (*entry.ifa_addr).sa_family as i32 };
            if family == libc::AF_INET {
                // SAFETY: `sa_family == AF_INET`.
                let addr =
                    unsafe { std::ptr::read_unaligned(entry.ifa_addr.cast::<libc::sockaddr_in>()).sin_addr.s_addr };
                let ip = IpAddr::V4(Ipv4Addr::from(addr.to_ne_bytes()));
                ips.push(InterfaceAddress { ip, internal: internal || ip.is_loopback() });
            } else if family == libc::AF_INET6 {
                // SAFETY: `sa_family == AF_INET6`.
                let bytes =
                    unsafe { std::ptr::read_unaligned(entry.ifa_addr.cast::<libc::sockaddr_in6>()).sin6_addr.s6_addr };
                let ip = IpAddr::V6(Ipv6Addr::from(bytes));
                ips.push(InterfaceAddress { ip, internal: internal || ip.is_loopback() });
            }
        }
        cursor = entry.ifa_next;
    }
    ips
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iface(ip: &str, internal: bool) -> InterfaceAddress {
        InterfaceAddress { ip: ip.parse().unwrap(), internal }
    }

    #[test]
    fn wildcard_ipv4_prefers_private_over_public_over_link_local() {
        let ips = [
            iface("169.254.10.20", false),
            iface("203.0.113.5", false),
            iface("192.168.1.20", false),
            iface("10.99.0.1", true),
            iface("127.0.0.1", true),
            iface("2001:db8::20", false),
            iface("fe80::1", false),
        ];
        let resolved = resolve_remote("0.0.0.0".parse().unwrap(), 9898, false, &ips);
        assert_eq!(resolved.primary_url, "https://192.168.1.20:9898");
        let ordered: Vec<&str> = resolved.addresses.iter().map(|a| a.ip.as_str()).collect();
        assert_eq!(ordered, ["192.168.1.20", "203.0.113.5", "169.254.10.20"]);
        assert!(!ordered.contains(&"10.99.0.1"), "internal loopback interface must not be external");
        assert!(resolved.listener_origins.contains(&"https://192.168.1.20:9898".to_owned()));
        assert!(resolved.listener_origins.contains(&"https://203.0.113.5:9898".to_owned()));
        assert!(resolved.listener_origins.contains(&"https://127.0.0.1:9898".to_owned()));
    }

    #[test]
    fn wildcard_falls_back_to_loopback_when_no_external_interface_exists() {
        let v4 = resolve_remote(
            "0.0.0.0".parse().unwrap(),
            9898,
            false,
            &[iface("127.0.0.1", true), iface("10.99.0.1", true), iface("127.0.0.2", true)],
        );
        assert_eq!(v4.primary_url, "https://127.0.0.1:9898");
        assert_eq!(v4.addresses.len(), 3);
        assert!(v4.addresses.iter().all(|a| a.scope == "loopback"));
        assert!(v4.listener_origins.contains(&"https://127.0.0.2:9898".to_owned()));
        assert!(v4.direct_origins.is_empty(), "internal loopback fallback must never expose direct pairing origins");

        let v6 = resolve_remote("::".parse().unwrap(), 9898, false, &[iface("::1", true), iface("fe80::1", false)]);
        assert_eq!(v6.primary_url, "https://[::1]:9898");
        assert_eq!(v6.addresses.len(), 1);
        assert_eq!(v6.addresses[0].ip, "::1");
        assert!(v6.direct_origins.is_empty());
    }

    #[test]
    fn wildcard_ipv6_respects_dual_stack_capability() {
        let ips =
            [iface("fe80::1", false), iface("2001:db8::20", false), iface("192.168.1.20", false), iface("::1", true)];
        let dual = resolve_remote("::".parse().unwrap(), 9898, true, &ips);
        assert_eq!(dual.primary_url, "https://192.168.1.20:9898");
        let dual_ips: Vec<&str> = dual.addresses.iter().map(|a| a.ip.as_str()).collect();
        assert_eq!(dual_ips, ["192.168.1.20", "2001:db8::20"]);

        let v6_only = resolve_remote("::".parse().unwrap(), 9898, false, &ips);
        assert_eq!(v6_only.primary_url, "https://[2001:db8::20]:9898");
        let v6_ips: Vec<&str> = v6_only.addresses.iter().map(|a| a.ip.as_str()).collect();
        assert_eq!(v6_ips, ["2001:db8::20"]);
        assert!(!v6_only.listener_origins.iter().any(|o| o.contains("127.0.0.1")));
    }

    #[test]
    fn concrete_loopback_admits_both_localhost_and_ip_alias() {
        let resolved = resolve_remote("127.0.0.1".parse().unwrap(), 9898, false, &[]);
        assert_eq!(resolved.primary_url, "https://localhost:9898");
        assert_eq!(resolved.listener_origins, ["https://localhost:9898", "https://127.0.0.1:9898"]);
    }

    #[test]
    fn host_interface_discovery_finds_loopback() {
        let ips = host_interface_ips();
        assert!(ips.iter().any(|entry| entry.ip.is_loopback() && entry.internal), "expected loopback in {ips:?}");
    }
}
