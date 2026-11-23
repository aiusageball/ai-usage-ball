import Foundation
import Network
import Combine

struct APIStats: Decodable {
    var codex: ModelStat?
    var claude: ModelStat?
    var antigravity: ModelStat?
    
    struct ModelStat: Decodable {
        var available: Bool? = nil
        var rate_limit_pct: Double?
        var rate_limit_pct_secondary: Double?
        var status: String?
        var status_secondary: String?
        var resetsAt: String?
        var resetsAt_secondary: String?
        
        enum CodingKeys: String, CodingKey {
            case available
            case rate_limit_pct
            case rate_limit_pct_secondary
            case status
            case status_secondary
            case resetsAt
            case resetsAt_secondary
        }
        
        // remaining % = 100 - used% (matching Mac: 100 - data.claude.rate_limit_pct)
        var remainingPct: Double {
            100.0 - (rate_limit_pct ?? 0)
        }
        var remainingPctSecondary: Double {
            100.0 - (rate_limit_pct_secondary ?? 0)
        }
        
        var exhausted: Bool {
            return status == "EXHAUSTED" || remainingPct <= 0
        }
    }
}

class NetworkManager: ObservableObject {
    @Published var stats: APIStats?
    @Published var connectionStatus: String = "正在搜索 Mac..."
    @Published var isDemoMode: Bool = false
    @Published var searchTimedOut: Bool = false

    private var browser: NWBrowser?
    private var connection: NWConnection?
    private var serverURL: URL?
    private var timer: Timer?
    private var searchTimeoutTimer: Timer?

    init() {
        startBrowsing()
    }

    func retryBrowsing() {
        startBrowsing()
    }

    func exitDemoMode() {
        startBrowsing()
    }

    func enableDemoMode() {
        browser?.cancel()
        browser = nil
        connection?.cancel()
        connection = nil
        timer?.invalidate()
        timer = nil
        searchTimeoutTimer?.invalidate()
        searchTimeoutTimer = nil

        let now = Date()
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]

        let demoStats = APIStats(
            codex: APIStats.ModelStat(
                rate_limit_pct: 32.0,
                rate_limit_pct_secondary: 12.0,
                status: "NORMAL",
                status_secondary: "NORMAL",
                resetsAt: iso.string(from: now.addingTimeInterval(3 * 3600 + 18 * 60)),
                resetsAt_secondary: iso.string(from: now.addingTimeInterval(5 * 86400))
            ),
            claude: APIStats.ModelStat(
                rate_limit_pct: 24.0,
                rate_limit_pct_secondary: 18.0,
                status: "NORMAL",
                status_secondary: "NORMAL",
                resetsAt: iso.string(from: now.addingTimeInterval(2 * 3600 + 47 * 60)),
                resetsAt_secondary: iso.string(from: now.addingTimeInterval(4 * 86400))
            ),
            antigravity: APIStats.ModelStat(
                rate_limit_pct: 28.0,
                rate_limit_pct_secondary: 15.0,
                status: "NORMAL",
                status_secondary: "NORMAL",
                resetsAt: iso.string(from: now.addingTimeInterval(4 * 3600 + 5 * 60)),
                resetsAt_secondary: iso.string(from: now.addingTimeInterval(1 * 3600 + 52 * 60))
            )
        )

        DispatchQueue.main.async {
            self.isDemoMode = true
            self.searchTimedOut = false
            self.stats = demoStats
            self.connectionStatus = "Connected"
        }
    }

    func startBrowsing() {
        browser?.cancel()
        browser = nil
        connection?.cancel()
        connection = nil
        timer?.invalidate()
        timer = nil
        searchTimeoutTimer?.invalidate()
        searchTimeoutTimer = nil

        isDemoMode = false
        searchTimedOut = false
        connectionStatus = "正在搜索 Mac..."

        #if targetEnvironment(simulator)
        print("Running in Simulator: Bypassing Bonjour and connecting directly to Mac localhost.")
        self.serverURL = URL(string: "http://127.0.0.1:8000/api/stats")
        DispatchQueue.main.async {
            self.connectionStatus = "Connected"
            self.startPolling()
        }
        #else
        let parameters = NWParameters()
        parameters.includePeerToPeer = true

        browser = NWBrowser(for: .bonjour(type: "_aipulse._tcp", domain: "local."), using: parameters)

        browser?.stateUpdateHandler = { newState in
            switch newState {
            case .failed(let error):
                print("Browser failed: \(error)")
            case .ready:
                print("Browser ready")
            default:
                break
            }
        }

        browser?.browseResultsChangedHandler = { [weak self] results, changes in
            for result in results {
                if case NWEndpoint.service(let name, let type, let domain, _) = result.endpoint {
                    print("Found service: \(name) \(type) \(domain)")
                    self?.resolveEndpoint(endpoint: result.endpoint)
                    self?.browser?.cancel()
                    break
                }
            }
        }

        browser?.start(queue: .main)

        searchTimeoutTimer = Timer.scheduledTimer(withTimeInterval: 6.0, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            if self.connectionStatus != "Connected" && !self.isDemoMode {
                self.searchTimedOut = true
                self.connectionStatus = "未发现 Mac 端"
            }
        }
        #endif
    }

    private func resolveEndpoint(endpoint: NWEndpoint) {
        print("Resolving endpoint: \(endpoint)")
        let connection = NWConnection(to: endpoint, using: .tcp)
        self.connection = connection
        
        connection.stateUpdateHandler = { [weak self] state in
            print("Connection state changed: \(state)")
            switch state {
            case .ready:
                if let endpoint = connection.currentPath?.remoteEndpoint,
                   case .hostPort(let host, let port) = endpoint {
                    
                    var hostString = ""
                    switch host {
                    case .ipv4(let addr): 
                        hostString = "\(addr)".components(separatedBy: "%").first ?? "\(addr)"
                    case .ipv6(let addr): 
                        let cleanAddr = "\(addr)".components(separatedBy: "%").first ?? "\(addr)"
                        hostString = "[\(cleanAddr)]"
                    case .name(let name, _): 
                        hostString = name
                    @unknown default: hostString = ""
                    }
                    
                    let urlString = "http://\(hostString):\(port.rawValue)/api/stats"
                    print("Resolved server URL: \(urlString)")
                    self?.serverURL = URL(string: urlString)
                    DispatchQueue.main.async {
                        self?.connectionStatus = "Connected"
                        self?.startPolling()
                    }
                }
                // We just needed to resolve the IP, we don't need to hold the raw TCP connection open for HTTP
                connection.cancel()
            case .failed(let error):
                print("Connection failed: \(error)")
            default:
                break
            }
        }
        connection.start(queue: .main)
    }
    
    func startPolling() {
        timer?.invalidate()
        // 用量变化很慢,3 秒拉一次足够;倒计时在 UI 本地每秒推算,不受影响。
        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.fetchStats()
        }
        fetchStats()
    }
    
    func fetchStats() {
        guard let url = serverURL else { return }
        print("Fetching stats from URL: \(url)")
        
        URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            if let error = error {
                print("HTTP Request Error: \(error.localizedDescription)")
                DispatchQueue.main.async {
                    self?.connectionStatus = "Sync Error"
                }
                return
            }
            
            if let data = data {
                // 在主线程解码:APIStats 是 main-actor 隔离的(工程默认隔离),
                // 在主 actor 上用它的 Decodable 实现就不会再有并发警告。
                DispatchQueue.main.async {
                    do {
                        let decoded = try JSONDecoder().decode(APIStats.self, from: data)
                        self?.stats = decoded
                        self?.connectionStatus = "Connected"
                    } catch {
                        print("Decoding error: \(error)")
                        self?.connectionStatus = "Decoding Error"
                    }
                }
            }
        }.resume()
    }
}
