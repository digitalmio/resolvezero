
use super::*;
use hickory_proto::op::{Message, MessageType, Query};
use hickory_proto::rr::{Name, RData, Record, RecordType};
use std::str::FromStr;

fn config() -> AgentConfig {
    AgentConfig {
        profile_id: "profile-id".into(),
        token: "secret-token".into(),
        doh_url: "https://edge.example".into(),
        bind_host: "127.0.0.1".into(),
        dns_port: 0,
        timeout_ms: 5_000,
        health_port: 0,
        health_host: "127.0.0.1".into(),
        devices: Default::default(),
    }
}

fn query(name: &str) -> Vec<u8> {
    let mut msg = Message::new();
    msg.set_id(0x4242);
    msg.set_message_type(MessageType::Query);
    msg.set_recursion_desired(true);
    msg.add_query(Query::query(Name::from_str(name).unwrap(), RecordType::A));
    msg.to_vec().unwrap()
}

fn answer(name: &str) -> Vec<u8> {
    let mut msg = Message::new();
    msg.set_id(0x4242);
    msg.set_message_type(MessageType::Response);
    msg.set_recursion_available(true);
    msg.add_query(Query::query(Name::from_str(name).unwrap(), RecordType::A));
    msg.add_answer(Record::from_rdata(
        Name::from_str(name).unwrap(),
        60,
        RData::A("1.2.3.4".parse().unwrap()),
    ));
    msg.to_vec().unwrap()
}

async fn udp_query(port: u16, wire: Vec<u8>) -> Vec<u8> {
    let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    socket.send_to(&wire, ("127.0.0.1", port)).await.unwrap();
    let mut buf = vec![0u8; 65_535];
    let (len, _) = tokio::time::timeout(Duration::from_secs(2), socket.recv_from(&mut buf))
        .await
        .expect("udp timeout")
        .unwrap();
    buf[..len].to_vec()
}

async fn tcp_query(port: u16, wire: Vec<u8>) -> Vec<u8> {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut frame = Vec::with_capacity(wire.len() + 2);
    frame.extend_from_slice(&(wire.len() as u16).to_be_bytes());
    frame.extend_from_slice(&wire);
    socket.write_all(&frame).await.unwrap();
    let mut len_buf = [0u8; 2];
    tokio::time::timeout(Duration::from_secs(2), socket.read_exact(&mut len_buf))
        .await
        .expect("tcp timeout")
        .unwrap();
    let len = u16::from_be_bytes(len_buf) as usize;
    let mut payload = vec![0u8; len];
    socket.read_exact(&mut payload).await.unwrap();
    payload
}

#[tokio::test]
async fn serves_udp_and_tcp_through_the_injected_resolver() {
    let seen = Arc::new(std::sync::Mutex::new(Vec::<IpAddr>::new()));
    let seen_handler = seen.clone();
    let resolver: Resolver = Arc::new(move |_query, ip| {
        seen_handler.lock().unwrap().push(ip);
        Box::pin(async { Ok(answer("example.com")) })
    });
    let agent = start_agent(config(), resolver).await.unwrap();

    let udp = udp_query(agent.udp_port, query("example.com")).await;
    let msg = Message::from_vec(&udp).unwrap();
    assert_eq!(msg.id(), 0x4242);
    match msg.answers()[0].data() {
        Some(RData::A(addr)) => assert_eq!(addr.to_string(), "1.2.3.4"),
        other => panic!("unexpected answer {other:?}"),
    }

    let tcp = tcp_query(agent.tcp_port, query("example.com")).await;
    let msg = Message::from_vec(&tcp).unwrap();
    assert_eq!(msg.id(), 0x4242);

    assert_eq!(seen.lock().unwrap().len(), 2);
    agent.close().await;
}

#[tokio::test]
async fn returns_servfail_when_the_resolver_throws() {
    let resolver: Resolver =
        Arc::new(|_query, _ip| Box::pin(async { Err("edge down".to_string()) }));
    let agent = start_agent(config(), resolver).await.unwrap();
    let reply = udp_query(agent.udp_port, query("example.com")).await;
    let msg = Message::from_vec(&reply).unwrap();
    assert_eq!(
        msg.response_code(),
        hickory_proto::op::ResponseCode::ServFail
    );
    agent.close().await;
}

#[tokio::test]
async fn returns_servfail_on_transaction_id_mismatch() {
    let resolver: Resolver = Arc::new(|_query, _ip| {
        Box::pin(async {
            let mut msg = Message::from_vec(&answer("example.com")).unwrap();
            msg.set_id(0x1111);
            Ok(msg.to_vec().unwrap())
        })
    });
    let agent = start_agent(config(), resolver).await.unwrap();
    let reply = udp_query(agent.udp_port, query("example.com")).await;
    let msg = Message::from_vec(&reply).unwrap();
    assert_eq!(
        msg.response_code(),
        hickory_proto::op::ResponseCode::ServFail
    );
    agent.close().await;
}

#[tokio::test]
async fn truncates_oversized_udp_answers() {
    // 300 answers make the response far larger than the 512-byte default.
    let resolver: Resolver = Arc::new(|_query, _ip| {
        Box::pin(async {
            let mut msg = Message::from_vec(&query("example.com")).unwrap();
            msg.set_message_type(MessageType::Response);
            msg.set_recursion_available(true);
            for i in 0..300u16 {
                msg.add_answer(Record::from_rdata(
                    Name::from_str("example.com").unwrap(),
                    60,
                    RData::A(format!("10.0.{}.{}", i / 256, i % 256).parse().unwrap()),
                ));
            }
            Ok(msg.to_vec().unwrap())
        })
    });
    let agent = start_agent(config(), resolver).await.unwrap();
    let reply = udp_query(agent.udp_port, query("example.com")).await;
    let msg = Message::from_vec(&reply).unwrap();
    assert!(msg.truncated());
    agent.close().await;
}

#[tokio::test]
async fn health_endpoint_reports_ready() {
    let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);

    let mut config = config();
    config.health_port = port;
    let resolver: Resolver = Arc::new(|_query, _ip| Box::pin(async { Ok(answer("example.com")) }));
    let agent = start_agent(config, resolver).await.unwrap();
    assert_eq!(agent.health_port, port);

    let mut socket = TcpStream::connect(("127.0.0.1", agent.health_port))
        .await
        .unwrap();
    socket
        .write_all(b"GET /healthz HTTP/1.1\r\nhost: localhost\r\n\r\n")
        .await
        .unwrap();
    let mut response = Vec::new();
    socket.read_to_end(&mut response).await.unwrap();
    let text = String::from_utf8_lossy(&response);
    assert!(text.starts_with("HTTP/1.1 200 OK"), "{text}");
    assert!(text.contains("\"ok\":true"), "{text}");
    assert!(text.contains("profile-id"), "{text}");

    agent.close().await;
}
