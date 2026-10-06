import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

// Parses the production XML, optionally the real Gradle-merged manifest.
// This is a configuration regression, NOT a WebView/network execution test.
public final class TransportPolicyTest {
    private static final String ANDROID = "http://schemas.android.com/apk/res/android";
    private static final String RESOURCE = "codenomad_mobile_network_security";

    private static void require(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static Document xml(Path file) throws Exception {
        var factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        return factory.newDocumentBuilder().parse(file.toFile());
    }

    private static Element single(Document document, String tag) {
        NodeList nodes = document.getElementsByTagName(tag);
        require(nodes.getLength() == 1, "Exactly one " + tag);
        return (Element) nodes.item(0);
    }

    public static void main(String[] args) throws Exception {
        Path main = Path.of("src-tauri/recovery/android/src/main");
        Path manifest = args.length == 0 ? main.resolve("AndroidManifest.xml") : Path.of(args[0]);
        Path policyPath = args.length < 2 ? main.resolve("res/xml/" + RESOURCE + ".xml") : Path.of(args[1]);
        String reference = args.length < 3 ? "@xml/" + RESOURCE : args[2];
        var application = single(xml(manifest), "application");
        require(application.getAttributeNS(ANDROID, "networkSecurityConfig").equals(reference),
            "Production/merged application must use owned NSC");
        var policy = xml(policyPath);
        require(policy.getDocumentElement().getTagName().equals("network-security-config"), "NSC root");
        var base = single(policy, "base-config");
        require(base.getAttribute("cleartextTrafficPermitted").equals("false"), "Base must deny cleartext");
        var domainConfig = single(policy, "domain-config");
        require(domainConfig.getAttribute("cleartextTrafficPermitted").equals("false"), "Loopback must deny cleartext");
        require(single(policy, "certificates").getAttribute("src").equals("system"), "System CA trust only");
        require(single(policy, "trust-anchors").getParentNode() == base, "Loopback inherits system trust");
        require(policy.getElementsByTagName("debug-overrides").getLength() == 0, "No debug trust override");
        require(!Files.exists(main.resolve("res/xml/" + RESOURCE + "_debug.xml")), "No implicit debug resource");
        NodeList domains = policy.getElementsByTagName("domain");
        var expected = List.of("localhost", "ip6-localhost", "127.0.0.1", "::1");
        require(domains.getLength() == expected.size(), "Only explicit denying loopback rules");
        for (int i = 0; i < domains.getLength(); i++) {
            var domain = (Element) domains.item(i);
            require(domain.getTextContent().trim().equals(expected.get(i)), "Explicit domain " + expected.get(i));
            require(domain.getParentNode() == domainConfig, "Every domain uses denial");
            if (i < 2) require(domain.getAttribute("includeSubdomains").equals("true"), "Localhost subdomains denied");
        }
        // Android 17 XmlConfigSource.isLocalhostDefined suppresses the implicit
        // fallback globally when ANY loopback domain is present. Thus other
        // loopback spellings inherit this false base, not an implicit true rule.
        for (String host : List.of("localhost", "LOCALHOST.", "ip6-localhost", "127.0.0.1",
                "127.0.0.2", "127.255.255.254", "[::1]", "::1", "0:0:0:0:0:0:0:1",
                "[0:0:0:0:0:0:0:1]", "tauri.localhost", "ipc.localhost", "server.example")) {
            String normalized = host.toLowerCase(java.util.Locale.ROOT).replaceAll("\\.$", "");
            if (normalized.startsWith("[")) normalized = normalized.substring(1, normalized.length() - 1);
            Element effective = base;
            for (int i = 0; i < domains.getLength(); i++) {
                var domain = (Element) domains.item(i);
                String name = domain.getTextContent().trim();
                if (normalized.equals(name) || (domain.getAttribute("includeSubdomains").equals("true") &&
                        normalized.endsWith("." + name))) effective = (Element) domain.getParentNode();
            }
            require(effective.getAttribute("cleartextTrafficPermitted").equals("false"), "XML rule for " + host);
        }
        System.out.println("Production XML/manifest: base and loopback cleartext denied, system CA only; " + manifest);
        System.out.println("Structural variants covered; no claim of real WebView/network absence.");
    }
}
