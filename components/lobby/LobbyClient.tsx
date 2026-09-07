//DEV NOTE : Friends 1v1 ... pregame lobby (should include "READY" , "MIC FOR TRASH TALK" , "SCREENS SIDE BY SIDE") 

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { supabase, getPlayerId, type Room } from "@/lib/supabase";

interface Props { roomId: string; }

type LobbyState = "camera_prompt" | "connecting" | "waiting" | "lobby" | "countdown" | "error";

function saveSession(key: string, value: string) { try { sessionStorage.setItem(key, value); } catch {} }
function loadSession(key: string): string | null { try { return sessionStorage.getItem(key); } catch { return null; } }
function clearSession(roomId: string) {
  try {
    sessionStorage.removeItem(`lobby_timer_start_${roomId}`);
    sessionStorage.removeItem(`lobby_ready_${roomId}`);
  } catch {}
}

const LOBBY_DURATION = 30;

// ── Apple-inspired design tokens ─────────────────────────────────
const SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif';
const COLORS = {
  bg:         "#000000",
  surface1:   "rgba(255,255,255,0.06)",  // subtle glass
  surface2:   "rgba(255,255,255,0.10)",  // raised glass
  surface3:   "rgba(28,28,30,0.72)",     // solid glass HUD (iOS-like)
  border:     "rgba(255,255,255,0.09)",  // hairline borders
  borderBold: "rgba(255,255,255,0.18)",
  text:       "#FFFFFF",
  text2:      "rgba(255,255,255,0.60)",
  text3:      "rgba(255,255,255,0.38)",
  green:      "#30D158",                 // Apple system green
  greenDim:   "rgba(48,209,88,0.15)",
  red:        "#FF453A",                 // Apple system red
  redDim:     "rgba(255,69,58,0.15)",
  yellow:     "#FFD60A",                 // Apple system yellow
  yellowDim:  "rgba(255,214,10,0.12)",
};

export default function LobbyClient({ roomId }: Props) {
  const router   = useRouter();
  const playerId = getPlayerId();

  const localVideoRef  = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const pcRef          = useRef<RTCPeerConnection | null>(null);
  const isHostRef      = useRef(false);
  const makingOfferRef = useRef(false);
  const micTrackRef    = useRef<MediaStreamTrack | null>(null);

  const [lobbyState,     setLobbyState]     = useState<LobbyState>("camera_prompt");
  const [isHost,         setIsHost]         = useState(false);
  const [myReady,        setMyReady]        = useState(false);
  const [oppReady,       setOppReady]       = useState(false);
  const [countdown,      setCountdown]      = useState(3);
  const [copied,         setCopied]         = useState(false);
  const [error,          setError]          = useState("");
  const [lobbyTimer,     setLobbyTimer]     = useState(LOBBY_DURATION);
  const [cameraErr,      setCameraErr]      = useState("");
  const [remoteReady,    setRemoteReady]    = useState(false);
  const [isMuted,        setIsMuted]        = useState(false);
  const [oppSpeaking,    setOppSpeaking]    = useState(false);
  const [oppCameraIssue, setOppCameraIssue] = useState(false);

  const inviteUrl = typeof window !== "undefined" ? `${window.location.origin}/room/${roomId}` : "";

  function getRemainingLobbyTime(): number {
    const savedStart = loadSession(`lobby_timer_start_${roomId}`);
    if (!savedStart) return LOBBY_DURATION;
    const elapsed = (Date.now() - parseInt(savedStart)) / 1000;
    return Math.max(0, Math.ceil(LOBBY_DURATION - elapsed));
  }

  const setLocalVideoRef = useCallback((el: HTMLVideoElement | null) => {
    localVideoRef.current = el;
    if (el && streamRef.current) {
      const videoOnly = new MediaStream(streamRef.current.getVideoTracks());
      if (el.srcObject !== videoOnly) {
        el.srcObject = videoOnly;
        el.onloadedmetadata = () => { el.play().catch(() => {}); };
      }
    }
  }, []);
  const setRemoteVideoRef = useCallback((el: HTMLVideoElement | null) => {
    remoteVideoRef.current = el;
  }, []);

  const requestCamera = useCallback(async () => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      const unlock = new SpeechSynthesisUtterance(" ");
      unlock.volume = 0.01; unlock.rate = 2;
      window.speechSynthesis.speak(unlock);
    }
    try {
      const camPerm = await navigator.permissions.query({ name: "camera" as PermissionName });
      if (camPerm.state === "denied") { setCameraErr("blocked"); return; }
    } catch {}
    setCameraErr("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 },
                 frameRate: { ideal: 15 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true,
                 autoGainControl: true, sampleRate: 48000, channelCount: 1 },
      });
      streamRef.current = stream;
      const micTrack = stream.getAudioTracks()[0];
      if (micTrack) micTrackRef.current = micTrack;
      const vid = localVideoRef.current;
      if (vid) {
        const videoOnly = new MediaStream(stream.getVideoTracks());
        vid.srcObject = videoOnly;
        vid.onloadedmetadata = () => { vid.play().catch(() => {}); };
      }
      try { await supabase.from("rooms").update({ [`${isHostRef.current ? "host" : "guest"}_camera_ok`]: true }).eq("id", roomId); } catch {}
      setLobbyState("connecting");
      await initRoom();
    } catch {
      try {
        const videoOnly = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 },
                   frameRate: { ideal: 15 }, facingMode: "user" },
          audio: false,
        });
        streamRef.current = videoOnly;
        const vid = localVideoRef.current;
        if (vid) { vid.srcObject = videoOnly; vid.onloadedmetadata = () => { vid.play().catch(() => {}); }; }
        setLobbyState("connecting");
        await initRoom();
      } catch { setCameraErr("blocked"); }
    }
  }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleMute() {
    const t = micTrackRef.current; if (!t) return;
    t.enabled = !t.enabled;
    setIsMuted(!t.enabled);
  }

  function startVAD(stream: MediaStream) {
    try {
      const audioCtx = new AudioContext();
      const source   = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512; source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const check = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setOppSpeaking(avg > 10);
        requestAnimationFrame(check);
      };
      check();
    } catch {}
  }

  function createPeerConnection() {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "turn:openrelay.metered.ca:80",  username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turns:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
      ],
    });
    streamRef.current?.getTracks().forEach(track => pc.addTrack(track, streamRef.current!));
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (event.track.kind === "video") {
        setRemoteReady(true);
        const vid = remoteVideoRef.current;
        if (vid) {
          const videoOnly = new MediaStream(remoteStream.getVideoTracks());
          vid.srcObject = videoOnly; vid.muted = true;
          vid.onloadedmetadata = () => { vid.play().catch(() => {}); };
        }
      }
      if (event.track.kind === "audio") {
        const audioEl = remoteAudioRef.current;
        if (audioEl) {
          const audioOnly = new MediaStream([event.track]);
          audioEl.srcObject = audioOnly; audioEl.muted = false;
          audioEl.play().catch(() => {});
          startVAD(audioOnly);
        }
      }
    };
    pc.onicecandidate = async (event) => {
      if (!event.candidate) return;
      await supabase.from("signals").insert({
        room_id: roomId, from_id: playerId,
        to_id: isHostRef.current ? "guest" : "host",
        type: "ice", payload: event.candidate.toJSON(),
      });
    };
    pcRef.current = pc;
    return pc;
  }

  async function createOffer(pc: RTCPeerConnection) {
    makingOfferRef.current = true;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await supabase.from("signals").insert({
        room_id: roomId, from_id: playerId, to_id: "guest",
        type: "offer", payload: { type: offer.type, sdp: offer.sdp },
      });
    } finally { makingOfferRef.current = false; }
  }

  async function handleOffer(pc: RTCPeerConnection, payload: Record<string, unknown>) {
    await pc.setRemoteDescription(new RTCSessionDescription(payload as unknown as RTCSessionDescriptionInit));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await supabase.from("signals").insert({
      room_id: roomId, from_id: playerId, to_id: "host",
      type: "answer", payload: { type: answer.type, sdp: answer.sdp },
    });
  }
  async function handleAnswer(pc: RTCPeerConnection, payload: Record<string, unknown>) {
    if (pc.signalingState === "stable") return;
    await pc.setRemoteDescription(new RTCSessionDescription(payload as unknown as RTCSessionDescriptionInit));
  }
  async function handleIce(pc: RTCPeerConnection, payload: Record<string, unknown>) {
    try { await pc.addIceCandidate(new RTCIceCandidate(payload as unknown as RTCIceCandidateInit)); }
    catch { if (!makingOfferRef.current) console.warn("ICE error"); }
  }

  function subscribeToSignals(pc: RTCPeerConnection, myRole: "host" | "guest") {
    supabase.channel(`signals:${roomId}:${myRole}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "signals", filter: `room_id=eq.${roomId}` },
        async (payload) => {
          const signal = payload.new as { to_id: string; type: string; payload: Record<string, unknown> };
          if (signal.to_id !== myRole) return;
          if      (signal.type === "offer")  await handleOffer(pc, signal.payload);
          else if (signal.type === "answer") await handleAnswer(pc, signal.payload);
          else if (signal.type === "ice")    await handleIce(pc, signal.payload);
        })
      .subscribe();
  }

  const initRoom = useCallback(async () => {
    const { data } = await supabase.from("rooms").select("*").eq("id", roomId).maybeSingle();

    if (!data) {
      const { error: createErr } = await supabase.from("rooms").upsert({
        id: roomId, host_id: playerId, status: "waiting",
        host_ready: false, guest_ready: false,
        host_score: 0, guest_score: 0,
        guest_id: null, started_at: null, finished_at: null,
      });
      if (createErr) { setError("Failed to create room: " + createErr.message); setLobbyState("error"); return; }
      isHostRef.current = true; setIsHost(true); setLobbyState("waiting");
      return;
    }

    const room = data as Room;
    if (room.status === "battle") { router.push(`/battle/${roomId}?fresh=1`); return; }
    if (room.status === "finished") { setError("This match is already over."); setLobbyState("error"); return; }
    if (room.status === "countdown") { setLobbyState("countdown"); runCountdown(); return; }

    if (room.host_id === playerId) {
      isHostRef.current = true; setIsHost(true);
      setMyReady(room.host_ready); setOppReady(room.guest_ready);
      const savedReady = loadSession(`lobby_ready_${roomId}`);
      if (savedReady === "true" && !room.host_ready) {
        await supabase.from("rooms").update({ host_ready: true }).eq("id", roomId);
        setMyReady(true);
      }
      if (room.guest_id) {
        setLobbyState("lobby");
        setLobbyTimer(getRemainingLobbyTime());
        const pc = createPeerConnection();
        subscribeToSignals(pc, "host");
        await createOffer(pc);
      } else { setLobbyState("waiting"); }
    } else if (!room.guest_id || room.guest_id === playerId) {
      if (room.guest_id !== playerId) {
        const { error: joinErr } = await supabase.from("rooms")
          .update({ guest_id: playerId, status: "ready" }).eq("id", roomId);
        if (joinErr) { setError("Failed to join: " + joinErr.message); setLobbyState("error"); return; }
        saveSession(`lobby_timer_start_${roomId}`, Date.now().toString());
      }
      isHostRef.current = false; setIsHost(false);
      setMyReady(room.guest_ready); setOppReady(room.host_ready);
      const savedReady = loadSession(`lobby_ready_${roomId}`);
      if (savedReady === "true" && !room.guest_ready) {
        await supabase.from("rooms").update({ guest_ready: true }).eq("id", roomId);
        setMyReady(true);
      }
      setLobbyTimer(getRemainingLobbyTime());
      setLobbyState("lobby");
      const pc = createPeerConnection();
      subscribeToSignals(pc, "guest");
    } else { setError("This room is full."); setLobbyState("error"); }
  }, [roomId, playerId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lobbyState === "camera_prompt") return;
    const channel = supabase.channel(`room:${roomId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
        async (payload) => {
          const updated = payload.new as Room;
          if (updated.guest_id && lobbyState === "waiting" && isHostRef.current) {
            saveSession(`lobby_timer_start_${roomId}`, Date.now().toString());
            setLobbyTimer(LOBBY_DURATION);
            setLobbyState("lobby");
            const pc = createPeerConnection();
            subscribeToSignals(pc, "host");
            await createOffer(pc);
          }
          if (isHostRef.current) { setMyReady(updated.host_ready); setOppReady(updated.guest_ready); }
          else { setMyReady(updated.guest_ready); setOppReady(updated.host_ready); }
          if (updated.host_ready && updated.guest_ready && updated.status === "countdown") {
            setLobbyState("countdown"); runCountdown();
          }
          if (updated.status === "battle") { clearSession(roomId); router.push(`/battle/${roomId}?fresh=1`); }
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [lobbyState, roomId, router]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lobbyState !== "lobby") return;
    const interval = setInterval(() => {
      const remaining = getRemainingLobbyTime();
      setLobbyTimer(remaining);
      // ── AUTO-READY when trash talk timer ends ─────────────────────
      // If player hasn't tapped ready by the time trash talk ends,
      // auto-ready them so the battle can start
      if (remaining <= 0) {
        clearInterval(interval);
        if (!myReady) handleReady();
      }
    }, 500);
    return () => clearInterval(interval);
  }, [lobbyState, myReady]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lobbyState === "camera_prompt") return;
    const presenceChannel = supabase.channel(`presence:${roomId}`, { config: { presence: { key: playerId } } });
    presenceChannel.on("presence", { event: "sync" }, () => {
      const state = presenceChannel.presenceState<{ cameraOk: boolean }>();
      const others = Object.entries(state).filter(([key]) => key !== playerId).map(([, val]) => val[0]);
      if (others.length > 0) setOppCameraIssue(others[0]?.cameraOk === false);
    }).subscribe(async (status) => {
      if (status === "SUBSCRIBED") await presenceChannel.track({ cameraOk: true });
    });
    return () => { supabase.removeChannel(presenceChannel); };
  }, [lobbyState, roomId, playerId]);

  async function handleReady() {
    if (myReady) return;
    setMyReady(true);
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const unlock = new SpeechSynthesisUtterance(" ");
      unlock.volume = 0.01; unlock.rate = 2;
      window.speechSynthesis.speak(unlock);
    }
    saveSession(`lobby_ready_${roomId}`, "true");
    const field = isHost ? "host_ready" : "guest_ready";
    await supabase.from("rooms").update({ [field]: true }).eq("id", roomId);
    const { data } = await supabase.from("rooms").select("*").eq("id", roomId).single();
    if (data?.host_ready && data?.guest_ready) {
      await supabase.from("rooms").update({ status: "countdown" }).eq("id", roomId);
    }
  }

  function runCountdown() {
    let n = 3; setCountdown(n);
    const tick = setInterval(async () => {
      n--; setCountdown(n);
      if (n <= 0) {
        clearInterval(tick); clearSession(roomId);
        if (isHostRef.current) {
          await supabase.from("rooms")
            .update({ status: "battle", started_at: new Date().toISOString() })
            .eq("id", roomId);
        }
        router.push(`/battle/${roomId}?fresh=1`);
      }
    }, 1000);
  }

  async function copyInvite() {
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  }

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop());
      pcRef.current?.close();
    };
  }, []);

  // ═════════════════════════════════════════════════════════════
  // RENDER — Apple HIG applied throughout
  // ═════════════════════════════════════════════════════════════

  return (
    <div style={{
      position: "fixed", inset: 0, background: COLORS.bg,
      fontFamily: SYSTEM_FONT, color: COLORS.text,
      display: "flex", flexDirection: "column", overflow: "hidden",
      WebkitFontSmoothing: "antialiased", MozOsxFontSmoothing: "grayscale",
    }}>

      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />

      {/* ─── HEADER: minimal, refined ─── */}
      <header style={{
        padding: "14px 20px",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        flexShrink: 0, zIndex: 100,
        background: lobbyState === "lobby" ? "rgba(0,0,0,0.4)" : "transparent",
        backdropFilter: lobbyState === "lobby" ? "blur(20px) saturate(180%)" : "none",
        WebkitBackdropFilter: lobbyState === "lobby" ? "blur(20px) saturate(180%)" : "none",
        borderBottom: lobbyState === "lobby" ? `0.5px solid ${COLORS.border}` : "none",
      }}>
        <div style={{
          fontSize: 17, fontWeight: 700, letterSpacing: -0.4,
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <span>Locked&apos;N</span>
          <span style={{
            width: 6, height: 6, borderRadius: "50%",
            background: COLORS.green,
            boxShadow: `0 0 8px ${COLORS.green}`,
          }}/>
        </div>
        <StatusBadge state={lobbyState} />
      </header>

      {/* ═══ CAMERA PERMISSION SCREEN ═══ */}
      {lobbyState === "camera_prompt" && (
        <section style={{
          flex: 1, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          padding: "24px 24px 48px", gap: 24,
        }}>
          <div style={{
            width: 88, height: 88, borderRadius: 22,
            background: cameraErr ? COLORS.yellowDim : "linear-gradient(160deg, rgba(48,209,88,0.15), rgba(48,209,88,0.05))",
            border: `0.5px solid ${cameraErr ? "rgba(255,214,10,0.3)" : "rgba(48,209,88,0.3)"}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            backdropFilter: "blur(30px)",
            WebkitBackdropFilter: "blur(30px)",
          }}>
            {cameraErr ? <LockIcon size={40} color={COLORS.yellow}/> : <CameraIcon size={40} color={COLORS.green}/>}
          </div>

          <div style={{ textAlign: "center", maxWidth: 340 }}>
            <h1 style={{
              fontSize: 28, fontWeight: 700, letterSpacing: -0.6,
              margin: "0 0 8px", lineHeight: 1.15,
            }}>
              {cameraErr ? "Enable camera access" : "Camera & microphone"}
            </h1>
            <p style={{
              fontSize: 15, lineHeight: 1.4,
              color: COLORS.text2, margin: 0,
            }}>
              {cameraErr
                ? "Your browser blocked camera access. Update your settings, then reload."
                : "Both players need camera and mic to see and hear each other in the lobby."}
            </p>
          </div>

          {cameraErr && (
            <div style={{
              width: "100%", maxWidth: 340,
              padding: "16px 18px", borderRadius: 14,
              background: COLORS.surface3, backdropFilter: "blur(30px)",
              WebkitBackdropFilter: "blur(30px)",
              border: `0.5px solid ${COLORS.border}`,
              fontSize: 13, lineHeight: 1.5, color: COLORS.text2,
            }}>
              <div style={{ color: COLORS.text, fontWeight: 600, marginBottom: 10, fontSize: 14 }}>
                How to fix
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ color: COLORS.text3, fontSize: 11, marginBottom: 4,
                              textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
                  Chrome / Android
                </div>
                Tap the <span role="img" aria-label="lock">🔒</span> lock icon in the URL bar → Permissions → Camera → Allow
              </div>
              <div>
                <div style={{ color: COLORS.text3, fontSize: 11, marginBottom: 4,
                              textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
                  Safari / iPhone
                </div>
                <span style={{ display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}>
                  <SettingsIcon size={14} color={COLORS.text2} />
                </span>{" "}
                Settings → Safari → Camera → Allow
              </div>
            </div>
          )}

          <button
            onClick={cameraErr ? () => window.location.reload() : requestCamera}
            style={{
              width: "100%", maxWidth: 340, padding: "16px 24px",
              borderRadius: 14, border: 0, cursor: "pointer",
              background: cameraErr ? COLORS.yellow : COLORS.green,
              color: "#000", fontSize: 17, fontWeight: 600, letterSpacing: -0.2,
              fontFamily: SYSTEM_FONT,
              minHeight: 50, // 44pt+ touch target
              transition: "transform 0.15s ease, opacity 0.15s ease",
              WebkitTapHighlightColor: "transparent",
            }}
            onTouchStart={(e) => (e.currentTarget.style.transform = "scale(0.97)")}
            onTouchEnd={(e) => (e.currentTarget.style.transform = "scale(1)")}
          >
            {cameraErr ? "Reload & Try Again" : "Allow Camera & Microphone"}
          </button>

          <p style={{ fontSize: 12, color: COLORS.text3, textAlign: "center", margin: 0 }}>
            Nothing is uploaded or stored
          </p>
        </section>
      )}

      {/* ═══ CONNECTING ═══ */}
      {lobbyState === "connecting" && (
        <section style={{
          flex: 1, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 16,
        }}>
          <Spinner />
          <p style={{ fontSize: 15, color: COLORS.text2, margin: 0 }}>Setting up room…</p>
        </section>
      )}

      {/* ═══ WAITING — host with invite link ═══ */}
      {lobbyState === "waiting" && (
        <section style={{
          flex: 1, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "flex-start",
          padding: "16px 20px 24px", gap: 20, overflow: "auto",
        }}>
          {/* Camera preview */}
          <div style={{
            width: "100%", maxWidth: 380, aspectRatio: "4/3",
            borderRadius: 20, overflow: "hidden",
            background: "#0a0a0a", position: "relative",
            boxShadow: "0 20px 60px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(255,255,255,0.06)",
          }}>
            <video ref={setLocalVideoRef} playsInline muted autoPlay
              onContextMenu={(e) => e.preventDefault()}
              style={{ width: "100%", height: "100%", objectFit: "cover",
                       transform: "scaleX(-1)", pointerEvents: "none" }}/>
            <div style={{
              position: "absolute", top: 12, left: 12,
              padding: "5px 10px", borderRadius: 8,
              background: "rgba(0,0,0,0.5)", backdropFilter: "blur(20px)",
              WebkitBackdropFilter: "blur(20px)",
              fontSize: 11, fontWeight: 600, color: COLORS.text,
              letterSpacing: 0.2,
            }}>You</div>
          </div>

          {/* Invite card */}
          <div style={{
            width: "100%", maxWidth: 380,
            padding: 20, borderRadius: 20,
            background: COLORS.surface1,
            backdropFilter: "blur(30px)",
            WebkitBackdropFilter: "blur(30px)",
            border: `0.5px solid ${COLORS.border}`,
          }}>
            <div style={{
              fontSize: 12, color: COLORS.text3, marginBottom: 12,
              textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 600,
            }}>
              Send to your opponent
            </div>
            <div style={{
              padding: "12px 14px", borderRadius: 10,
              background: "rgba(0,0,0,0.35)",
              border: `0.5px solid ${COLORS.border}`,
              fontSize: 13, wordBreak: "break-all",
              color: COLORS.text2, marginBottom: 14,
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}>
              {inviteUrl}
            </div>
            <button onClick={copyInvite} style={{
              width: "100%", padding: "14px 0", borderRadius: 12,
              border: `0.5px solid ${copied ? "rgba(48,209,88,0.3)" : "transparent"}`,
              background: copied ? COLORS.greenDim : COLORS.green,
              color: copied ? COLORS.green : "#000",
              fontSize: 15, fontWeight: 600, cursor: "pointer",
              transition: "all 0.2s ease", minHeight: 48,
              fontFamily: SYSTEM_FONT,
              WebkitTapHighlightColor: "transparent",
            }}>
              {copied ? "Copied" : "Copy invite link"}
            </button>
          </div>

          {/* Status */}
          <div style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "10px 16px", borderRadius: 100,
            background: oppCameraIssue ? COLORS.yellowDim : COLORS.surface1,
            backdropFilter: "blur(30px)",
            WebkitBackdropFilter: "blur(30px)",
            border: `0.5px solid ${oppCameraIssue ? "rgba(255,214,10,0.3)" : COLORS.border}`,
          }}>
            <PulseDot color={oppCameraIssue ? COLORS.yellow : COLORS.green} />
            <span style={{
              fontSize: 13, color: oppCameraIssue ? COLORS.yellow : COLORS.text2,
              fontWeight: 500,
            }}>
              {oppCameraIssue ? "Opponent fixing camera…" : "Waiting for opponent"}
            </span>
          </div>

          <p style={{
            fontSize: 12, color: COLORS.text3, textAlign: "center",
            maxWidth: 300, lineHeight: 1.4, margin: 0,
          }}>
            The room stays open. They can join anytime using the link.
          </p>
        </section>
      )}

      {/* ═══ LOBBY — full-bleed cameras with glass HUD ═══ */}
      {lobbyState === "lobby" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>

          {/* OPPONENT (top half) */}
          <div style={{
            flex: 1, position: "relative", background: "#050505",
            overflow: "hidden",
          }}>
            <video ref={setRemoteVideoRef} playsInline muted autoPlay
              onContextMenu={(e) => e.preventDefault()}
              style={{
                width: "100%", height: "100%", objectFit: "cover",
                transform: "scaleX(-1)", pointerEvents: "none",
                opacity: remoteReady ? 1 : 0,
                transition: "opacity 0.4s ease",
              }}/>

            {!remoteReady && (
              <div style={{
                position: "absolute", inset: 0, display: "flex",
                flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12,
              }}>
                {oppCameraIssue ? (
                  <>
                    <div style={{
                      width: 60, height: 60, borderRadius: 30,
                      background: COLORS.yellowDim,
                      border: `0.5px solid rgba(255,214,10,0.3)`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <WarningIcon size={26} color={COLORS.yellow}/>
                    </div>
                    <div style={{ fontSize: 13, color: COLORS.yellow, textAlign: "center", maxWidth: 220 }}>
                      Opponent is fixing their camera
                    </div>
                  </>
                ) : (
                  <>
                    <Spinner />
                    <div style={{ fontSize: 13, color: COLORS.text3 }}>Connecting video…</div>
                  </>
                )}
              </div>
            )}

            {/* Opponent label pill */}
            <div style={{
              position: "absolute", top: 12, left: 12,
              display: "flex", alignItems: "center", gap: 8,
              padding: "6px 12px", borderRadius: 100,
              background: "rgba(0,0,0,0.5)",
              backdropFilter: "blur(20px) saturate(180%)",
              WebkitBackdropFilter: "blur(20px) saturate(180%)",
              border: `0.5px solid ${COLORS.border}`,
              zIndex: 5,
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.text }}>Opponent</span>
              {oppSpeaking && <SpeakingBars />}
            </div>

            {/* Ready badge */}
            <ReadyBadge ready={oppReady} position={{ top: 12, right: 12 }} />
          </div>

          {/* VS Badge — sits over the divider between cameras */}
          <VSBadge />

          {/* YOU (bottom half) */}
          <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
            <video ref={setLocalVideoRef} playsInline muted autoPlay
              onContextMenu={(e) => e.preventDefault()}
              style={{ width: "100%", height: "100%", objectFit: "cover",
                       transform: "scaleX(-1)", pointerEvents: "none" }}/>

            {/* Gradient for bottom controls readability */}
            <div style={{
              position: "absolute", inset: 0, pointerEvents: "none",
              background: "linear-gradient(to bottom, transparent 45%, rgba(0,0,0,0.75) 100%)",
            }}/>

            {/* YOU label pill */}
            <div style={{
              position: "absolute", top: 12, left: 12,
              padding: "6px 12px", borderRadius: 100,
              background: "rgba(0,0,0,0.5)",
              backdropFilter: "blur(20px) saturate(180%)",
              WebkitBackdropFilter: "blur(20px) saturate(180%)",
              border: `0.5px solid ${COLORS.border}`,
              fontSize: 12, fontWeight: 600, color: COLORS.text,
            }}>You</div>

            {/* Mute button */}
            <button onClick={toggleMute} style={{
              position: "absolute", top: 10, right: 12,
              width: 44, height: 44, borderRadius: 22,
              background: isMuted ? COLORS.redDim : "rgba(0,0,0,0.5)",
              backdropFilter: "blur(20px) saturate(180%)",
              WebkitBackdropFilter: "blur(20px) saturate(180%)",
              border: `0.5px solid ${isMuted ? "rgba(255,69,58,0.4)" : COLORS.border}`,
              cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: isMuted ? COLORS.red : COLORS.text,
              transition: "all 0.2s ease",
              WebkitTapHighlightColor: "transparent",
              zIndex: 10,
            }}>
              {isMuted ? <MicOffIcon size={20} color={COLORS.red}/> : <MicOnIcon size={20} color={COLORS.text}/>}
            </button>

            {/* Bottom controls */}
            <div style={{
              position: "absolute", bottom: 0, left: 0, right: 0,
              padding: "12px 16px 22px",
              display: "flex", flexDirection: "column", gap: 12,
            }}>
              {/* Timer row */}
              <div style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "0 4px",
              }}>
                <span style={{ fontSize: 12, color: COLORS.text3, fontWeight: 500 }}>
                  Trash talk
                </span>
                <span style={{
                  fontSize: 15, fontWeight: 600,
                  color: lobbyTimer <= 5 ? COLORS.red : COLORS.text2,
                  fontFeatureSettings: '"tnum"',
                  transition: "color 0.2s",
                }}>
                  {lobbyTimer}s
                </span>
              </div>

              {/* Ready button */}
              <button
                onClick={handleReady}
                disabled={myReady}
                style={{
                  width: "100%", padding: "16px 0", borderRadius: 14,
                  fontWeight: 600, fontSize: 17, letterSpacing: -0.2,
                  fontFamily: SYSTEM_FONT,
                  cursor: myReady ? "default" : "pointer",
                  background: myReady
                    ? "rgba(48,209,88,0.15)"
                    : COLORS.green,
                  color: myReady ? COLORS.green : "#000",
                  border: myReady ? `0.5px solid rgba(48,209,88,0.3)` : "none",
                  transition: "all 0.25s ease", minHeight: 54,
                  WebkitTapHighlightColor: "transparent",
                  backdropFilter: myReady ? "blur(20px)" : "none",
                  WebkitBackdropFilter: myReady ? "blur(20px)" : "none",
                }}>
                {myReady
                  ? (oppReady ? "Both ready — starting…" : "Waiting for opponent")
                  : "I'm ready"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ COUNTDOWN — full-screen overlay ═══ */}
      {lobbyState === "countdown" && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 20, zIndex: 200,
          background: "rgba(0,0,0,0.85)",
          backdropFilter: "blur(40px) saturate(180%)",
          WebkitBackdropFilter: "blur(40px) saturate(180%)",
        }}>
          <div style={{
            fontSize: 13, letterSpacing: 2, fontWeight: 600,
            color: COLORS.text3, textTransform: "uppercase",
          }}>Get Ready</div>
          <div style={{
            fontSize: 180, fontWeight: 700, letterSpacing: -8, lineHeight: 1,
            color: countdown <= 1 ? COLORS.green : COLORS.text,
            textShadow: countdown <= 1 ? `0 0 80px ${COLORS.green}66` : "none",
            transition: "all 0.2s ease",
            fontFeatureSettings: '"tnum"',
          }}>
            {countdown}
          </div>
          <div style={{ fontSize: 15, color: COLORS.text3 }}>30-second pushup battle</div>
        </div>
      )}

      {/* ═══ ERROR ═══ */}
      {lobbyState === "error" && (
        <section style={{
          flex: 1, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 20, padding: 24,
        }}>
          <div style={{
            width: 72, height: 72, borderRadius: 18,
            background: COLORS.redDim,
            border: `0.5px solid rgba(255,69,58,0.3)`,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <WarningIcon size={32} color={COLORS.red}/>
          </div>
          <div style={{ textAlign: "center", maxWidth: 320 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 8px", letterSpacing: -0.4 }}>
              Something went wrong
            </h1>
            <p style={{ fontSize: 15, color: COLORS.text2, margin: 0, lineHeight: 1.4 }}>
              {error}
            </p>
          </div>
          <button onClick={() => router.push("/")} style={{
            padding: "14px 32px", borderRadius: 12,
            border: `0.5px solid ${COLORS.borderBold}`,
            background: COLORS.surface1, color: COLORS.text,
            fontSize: 15, fontWeight: 600, cursor: "pointer",
            fontFamily: SYSTEM_FONT, minHeight: 48,
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            WebkitTapHighlightColor: "transparent",
          }}>Go Home</button>
        </section>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SUB-COMPONENTS (kept tiny, single-purpose)
// ═══════════════════════════════════════════════════════════════

function StatusBadge({ state }: { state: LobbyState }) {
  const config: Record<LobbyState, { text: string; color: string; bg: string }> = {
    camera_prompt: { text: "Setup",       color: COLORS.text2,  bg: COLORS.surface1 },
    connecting:    { text: "Connecting",  color: COLORS.text2,  bg: COLORS.surface1 },
    waiting:       { text: "Waiting",     color: COLORS.text2,  bg: COLORS.surface1 },
    lobby:         { text: "In Lobby",    color: COLORS.green,  bg: COLORS.greenDim },
    countdown:     { text: "Starting",    color: COLORS.green,  bg: COLORS.greenDim },
    error:         { text: "Error",       color: COLORS.red,    bg: COLORS.redDim },
  };
  const c = config[state];
  return (
    <div style={{
      padding: "5px 12px", borderRadius: 100,
      background: c.bg,
      backdropFilter: "blur(20px)",
      WebkitBackdropFilter: "blur(20px)",
      border: `0.5px solid ${COLORS.border}`,
      fontSize: 12, fontWeight: 600, color: c.color,
      letterSpacing: -0.1,
    }}>
      {c.text}
    </div>
  );
}

function ReadyBadge({ ready, position }: {
  ready: boolean;
  position: { top?: number; right?: number; bottom?: number; left?: number };
}) {
  return (
    <div style={{
      position: "absolute", ...position,
      display: "flex", alignItems: "center", gap: 6,
      padding: "6px 12px", borderRadius: 100,
      background: ready ? COLORS.greenDim : "rgba(0,0,0,0.5)",
      backdropFilter: "blur(20px) saturate(180%)",
      WebkitBackdropFilter: "blur(20px) saturate(180%)",
      border: `0.5px solid ${ready ? "rgba(48,209,88,0.4)" : COLORS.border}`,
      fontSize: 12, fontWeight: 600,
      color: ready ? COLORS.green : COLORS.text3,
      transition: "all 0.25s ease", zIndex: 5,
    }}>
      {ready && <span style={{ fontSize: 10 }}>✓</span>}
      <span>{ready ? "Ready" : "Not ready"}</span>
    </div>
  );
}

function PulseDot({ color }: { color: string }) {
  return (
    <div style={{
      width: 8, height: 8, borderRadius: "50%",
      background: color, position: "relative",
    }}>
      <div style={{
        position: "absolute", inset: -4, borderRadius: "50%",
        background: color, opacity: 0.4,
        animation: "pulse 1.8s ease-out infinite",
      }}/>
      <style>{`
        @keyframes pulse {
          0%   { transform: scale(0.8); opacity: 0.5; }
          70%  { transform: scale(1.6); opacity: 0; }
          100% { transform: scale(1.6); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

function Spinner() {
  return (
    <>
      <div style={{
        width: 24, height: 24, borderRadius: "50%",
        border: `2px solid ${COLORS.border}`,
        borderTopColor: COLORS.green,
        animation: "spin 0.9s linear infinite",
      }}/>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  );
}

function SpeakingBars() {
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 12 }}>
      {[4, 8, 6, 10, 5].map((h, i) => (
        <div key={i} style={{
          width: 2.5, height: h, borderRadius: 1.5, background: COLORS.green,
          animation: `voiceBar ${0.4 + i * 0.08}s ease-in-out infinite alternate`,
        }}/>
      ))}
      <style>{`
        @keyframes voiceBar {
          from { transform: scaleY(0.4); opacity: 0.6; }
          to   { transform: scaleY(1.2); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SVG ICONS (Apple SF Symbols style, works on every device)
// ═══════════════════════════════════════════════════════════════

function CameraIcon({ size = 24, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9.5 3.5L8 6H5C3.9 6 3 6.9 3 8V18C3 19.1 3.9 20 5 20H19C20.1 20 21 19.1 21 18V8C21 6.9 20.1 6 19 6H16L14.5 3.5H9.5Z"
            stroke={color} strokeWidth="1.6" strokeLinejoin="round"/>
      <circle cx="12" cy="13" r="4" stroke={color} strokeWidth="1.6"/>
    </svg>
  );
}

function LockIcon({ size = 24, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="10" width="16" height="11" rx="2" stroke={color} strokeWidth="1.6"/>
      <path d="M8 10V7C8 4.79 9.79 3 12 3C14.21 3 16 4.79 16 7V10"
            stroke={color} strokeWidth="1.6" strokeLinecap="round"/>
      <circle cx="12" cy="15" r="1.5" fill={color}/>
    </svg>
  );
}

function SettingsIcon({ size = 24, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M12.22 2H11.78A2 2 0 0 0 9.78 4V4.18A2 2 0 0 1 8.78 5.91L8.35 6.16A2 2 0 0 1 6.35 6.16L6.2 6.08A2 2 0 0 0 3.47 6.81L3.25 7.19A2 2 0 0 0 3.98 9.92L4.13 10.02A2 2 0 0 1 5.13 11.74V12.25A2 2 0 0 1 4.13 13.99L3.98 14.08A2 2 0 0 0 3.25 16.81L3.47 17.19A2 2 0 0 0 6.2 17.92L6.35 17.84A2 2 0 0 1 8.35 17.84L8.78 18.09A2 2 0 0 1 9.78 19.82V20A2 2 0 0 0 11.78 22H12.22A2 2 0 0 0 14.22 20V19.82A2 2 0 0 1 15.22 18.09L15.65 17.84A2 2 0 0 1 17.65 17.84L17.8 17.92A2 2 0 0 0 20.53 17.19L20.75 16.81A2 2 0 0 0 20.02 14.08L19.87 13.99A2 2 0 0 1 18.87 12.25V11.74A2 2 0 0 1 19.87 10L20.02 9.91A2 2 0 0 0 20.75 7.18L20.53 6.8A2 2 0 0 0 17.8 6.07L17.65 6.15A2 2 0 0 1 15.65 6.15L15.22 5.9A2 2 0 0 1 14.22 4.17V4A2 2 0 0 0 12.22 2Z"
        stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke={color} strokeWidth="1.7" />
    </svg>
  );
}

function MicOnIcon({ size = 24, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="9" y="3" width="6" height="12" rx="3" stroke={color} strokeWidth="1.6"/>
      <path d="M5 11C5 14.87 8.13 18 12 18C15.87 18 19 14.87 19 11"
            stroke={color} strokeWidth="1.6" strokeLinecap="round"/>
      <line x1="12" y1="18" x2="12" y2="22" stroke={color} strokeWidth="1.6" strokeLinecap="round"/>
    </svg>
  );
}

function MicOffIcon({ size = 24, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="9" y="3" width="6" height="12" rx="3" stroke={color} strokeWidth="1.6"/>
      <path d="M5 11C5 14.87 8.13 18 12 18C15.87 18 19 14.87 19 11"
            stroke={color} strokeWidth="1.6" strokeLinecap="round"/>
      <line x1="12" y1="18" x2="12" y2="22" stroke={color} strokeWidth="1.6" strokeLinecap="round"/>
      <line x1="3" y1="3" x2="21" y2="21" stroke={color} strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
}

function WarningIcon({ size = 24, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 3L2.5 20H21.5L12 3Z"
            stroke={color} strokeWidth="1.6" strokeLinejoin="round"/>
      <line x1="12" y1="10" x2="12" y2="14" stroke={color} strokeWidth="1.8" strokeLinecap="round"/>
      <circle cx="12" cy="17" r="1" fill={color}/>
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════
// VS BADGE — animated centerpiece between opponent and you
// ═══════════════════════════════════════════════════════════════

function VSBadge() {
  return (
    <div
      role="img"
      aria-label="Versus"
      style={{
      position: "absolute", top: "50%", left: "50%",
      transform: "translate(-50%, -50%)",
      zIndex: 20, pointerEvents: "none", isolation: "isolate",
      width: "clamp(132px, 38vw, 168px)",
      aspectRatio: "240 / 190",
    }}>
      {/* A fast energy line sells the impact without covering either camera. */}
      <div className="lockedn-vs-seam" style={{
        position: "absolute", top: "50%", left: "50%",
        width: "min(94vw, 540px)", height: 2,
        transform: "translate(-50%, -50%)",
        background: "linear-gradient(90deg, transparent 0%, rgba(48,209,88,0.15) 18%, #30D158 43%, #FFFFFF 50%, #30D158 57%, rgba(48,209,88,0.15) 82%, transparent 100%)",
        backgroundSize: "220% 100%",
        boxShadow: "0 0 10px rgba(48,209,88,0.65)",
      }}/>

      <div className="lockedn-vs-aura" style={{
        position: "absolute", inset: "8% 2%",
        borderRadius: "50%",
        background: "radial-gradient(ellipse, rgba(48,209,88,0.38) 0%, rgba(48,209,88,0.12) 38%, transparent 72%)",
        filter: "blur(8px)",
      }}/>

      <div className="lockedn-vs-stage" style={{ position: "absolute", inset: 0 }}>
        <svg
          className="lockedn-vs-emblem"
          width="100%" height="100%" viewBox="0 0 240 190"
          fill="none" xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          style={{ overflow: "visible", filter: "drop-shadow(0 11px 14px rgba(0,0,0,0.72)) drop-shadow(0 0 7px rgba(48,209,88,0.42))" }}
        >
          <defs>
            <linearGradient id="lockednVsWing" x1="24" y1="34" x2="102" y2="133" gradientUnits="userSpaceOnUse">
              <stop stopColor="#F7FFF9" />
              <stop offset="0.12" stopColor="#30D158" />
              <stop offset="0.48" stopColor="#071009" />
              <stop offset="1" stopColor="#020403" />
            </linearGradient>
            <linearGradient id="lockednVsFrame" x1="76" y1="42" x2="165" y2="149" gradientUnits="userSpaceOnUse">
              <stop stopColor="#FFFFFF" />
              <stop offset="0.16" stopColor="#30D158" />
              <stop offset="0.48" stopColor="#07120A" />
              <stop offset="0.78" stopColor="#30D158" />
              <stop offset="1" stopColor="#EFFFF3" />
            </linearGradient>
            <radialGradient id="lockednVsCore" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(120 88) rotate(90) scale(54 62)">
              <stop stopColor="#193E22" />
              <stop offset="0.4" stopColor="#07140A" />
              <stop offset="1" stopColor="#010201" />
            </radialGradient>
            <linearGradient id="lockednVsTextV" x1="108" y1="72" x2="108" y2="117" gradientUnits="userSpaceOnUse">
              <stop stopColor="#FFFFFF" />
              <stop offset="0.58" stopColor="#F4FFF7" />
              <stop offset="1" stopColor="#A9F5BB" />
            </linearGradient>
            <linearGradient id="lockednVsTextS" x1="140" y1="74" x2="140" y2="116" gradientUnits="userSpaceOnUse">
              <stop stopColor="#FFFFFF" />
              <stop offset="0.34" stopColor="#DFFFF0" />
              <stop offset="1" stopColor="#30D158" />
            </linearGradient>
            <clipPath id="lockednVsCoreClip">
              <path d="M120 48L168 95L120 143L72 95L120 48Z" />
            </clipPath>
          </defs>

          {/* Broken neon wings, inspired by the reference artwork. */}
          <g className="lockedn-vs-wings">
            <path d="M104 80L60 24L69 70L22 43L58 86L10 92L64 101L26 142L91 112L104 80Z"
                  fill="url(#lockednVsWing)" stroke="#30D158" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M136 80L180 24L171 70L218 43L182 86L230 92L176 101L214 142L149 112L136 80Z"
                  fill="url(#lockednVsWing)" stroke="#30D158" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M88 72L53 45L66 77L31 68L67 91" stroke="#F4FFF7" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.84" />
            <path d="M152 72L187 45L174 77L209 68L173 91" stroke="#F4FFF7" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.84" />
            <path d="M84 88L42 85M156 88L198 85" stroke="#30D158" strokeWidth="5" strokeLinecap="round" opacity="0.8" />
            <path d="M76 105L42 124M164 105L198 124" stroke="#30D158" strokeWidth="2" strokeLinecap="round" opacity="0.55" />
          </g>

          {/* Crossed energy blades. */}
          <g className="lockedn-vs-blades">
            <path d="M54 145L72 154L128 47L113 37L54 145Z" fill="#020403" stroke="#30D158" strokeWidth="2" strokeLinejoin="round" />
            <path d="M64 141L71 145L119 52L113 48L64 141Z" fill="#EFFFF3" />
            <path d="M186 145L168 154L112 47L127 37L186 145Z" fill="#020403" stroke="#30D158" strokeWidth="2" strokeLinejoin="round" />
            <path d="M176 141L169 145L121 52L127 48L176 141Z" fill="#30D158" />
            <path d="M49 150L78 163M191 150L162 163" stroke="#FFFFFF" strokeWidth="4" strokeLinecap="round" />
          </g>

          <circle className="lockedn-vs-orbit" cx="120" cy="95" r="78"
                  stroke="#30D158" strokeWidth="1.5" strokeDasharray="4 17" opacity="0.7" />

          {/* Layered armor frame and glowing core. */}
          <path d="M120 25L189 95L120 165L51 95L120 25Z" fill="#010201" stroke="#30D158" strokeWidth="2.5" />
          <path d="M120 35L178 95L120 155L62 95L120 35Z" fill="url(#lockednVsFrame)" stroke="#FFFFFF" strokeWidth="1.3" />
          <path d="M120 46L168 95L120 145L72 95L120 46Z" fill="url(#lockednVsCore)" stroke="#30D158" strokeWidth="2.5" />
          <path d="M120 55L159 95L120 136L81 95L120 55Z" stroke="rgba(255,255,255,0.34)" strokeWidth="1" />
          <path d="M72 95L120 46L97 95L120 145L72 95Z" fill="rgba(48,209,88,0.09)" />
          <path d="M168 95L120 46L143 95L120 145L168 95Z" fill="rgba(255,255,255,0.035)" />

          {/* Subtle tactical grid, clipped inside the core. */}
          <g clipPath="url(#lockednVsCoreClip)" opacity="0.24">
            {[72, 82, 92, 102, 112, 122, 132, 142, 152, 162].map((x) => (
              <line key={`vx-${x}`} x1={x} y1="48" x2={x} y2="143" stroke="#30D158" strokeWidth="0.6" />
            ))}
            {[55, 65, 75, 85, 95, 105, 115, 125, 135].map((y) => (
              <line key={`hy-${y}`} x1="72" y1={y} x2="168" y2={y} stroke="#30D158" strokeWidth="0.6" />
            ))}
            <path className="lockedn-vs-sweep" d="M43 45L69 45L143 145L117 145L43 45Z" fill="rgba(255,255,255,0.32)" />
          </g>

          {/* Custom vector lettering renders identically on Android and iPhone. */}
          <g className="lockedn-vs-type-glow" stroke="#30D158" strokeWidth="8"
             strokeLinejoin="round" paintOrder="stroke fill">
            <path d="M84 72H98L107 100L118 72H132L114 117H99L84 72Z" fill="url(#lockednVsTextV)" />
            <path d="M156 74L152 85H133C130 85 128 86 128 89C128 91 130 92 134 92H142C151 92 155 96 155 103C155 112 149 116 138 116H117L121 106H140C144 106 145 105 145 102C145 100 143 99 140 99H131C122 99 118 95 118 88C118 79 124 74 134 74H156Z" fill="url(#lockednVsTextS)" />
          </g>
          <g stroke="#010301" strokeWidth="4" strokeLinejoin="round" paintOrder="stroke fill">
            <path d="M84 72H98L107 100L118 72H132L114 117H99L84 72Z" fill="url(#lockednVsTextV)" />
            <path d="M156 74L152 85H133C130 85 128 86 128 89C128 91 130 92 134 92H142C151 92 155 96 155 103C155 112 149 116 138 116H117L121 106H140C144 106 145 105 145 102C145 100 143 99 140 99H131C122 99 118 95 118 88C118 79 124 74 134 74H156Z" fill="url(#lockednVsTextS)" />
          </g>

          {/* Impact sparks. */}
          <g fill="#FFFFFF">
            <circle className="lockedn-vs-spark lockedn-vs-spark-a" cx="29" cy="62" r="2.6" />
            <circle className="lockedn-vs-spark lockedn-vs-spark-b" cx="207" cy="55" r="2" />
            <circle className="lockedn-vs-spark lockedn-vs-spark-c" cx="218" cy="119" r="2.4" />
            <circle className="lockedn-vs-spark lockedn-vs-spark-d" cx="31" cy="126" r="1.8" />
          </g>
          <g stroke="#30D158" strokeWidth="2.2" strokeLinecap="round">
            <path className="lockedn-vs-spark lockedn-vs-spark-a" d="M14 67L4 63" />
            <path className="lockedn-vs-spark lockedn-vs-spark-b" d="M221 73L236 67" />
            <path className="lockedn-vs-spark lockedn-vs-spark-c" d="M206 137L218 146" />
            <path className="lockedn-vs-spark lockedn-vs-spark-d" d="M35 43L27 33" />
          </g>
        </svg>
      </div>

      <style>{`
        .lockedn-vs-stage {
          animation: lockednVsImpact 720ms cubic-bezier(.18,.9,.2,1.2) both,
                     lockednVsFloat 3.4s 720ms ease-in-out infinite;
          transform-origin: center;
          will-change: transform, opacity;
        }
        .lockedn-vs-aura {
          animation: lockednVsAura 2.4s ease-in-out infinite;
          will-change: transform, opacity;
        }
        .lockedn-vs-seam {
          animation: lockednVsSeam 2.8s ease-in-out infinite;
          will-change: opacity, background-position;
        }
        .lockedn-vs-orbit {
          transform-box: fill-box;
          transform-origin: center;
          animation: lockednVsOrbit 10s linear infinite;
        }
        .lockedn-vs-type-glow {
          transform-box: fill-box;
          transform-origin: center;
          animation: lockednVsType 1.9s ease-in-out infinite;
        }
        .lockedn-vs-sweep {
          animation: lockednVsSweep 3.2s 900ms cubic-bezier(.45,0,.2,1) infinite;
          will-change: transform, opacity;
        }
        .lockedn-vs-spark {
          transform-box: fill-box;
          transform-origin: center;
          animation: lockednVsSpark 2.8s ease-out infinite;
          will-change: transform, opacity;
        }
        .lockedn-vs-spark-b { animation-delay: 420ms; }
        .lockedn-vs-spark-c { animation-delay: 860ms; }
        .lockedn-vs-spark-d { animation-delay: 1.24s; }

        @keyframes lockednVsImpact {
          0%   { opacity: 0; transform: scale(.34) rotate(-13deg); }
          58%  { opacity: 1; transform: scale(1.12) rotate(2deg); }
          78%  { transform: scale(.96) rotate(-1deg); }
          100% { opacity: 1; transform: scale(1) rotate(0); }
        }
        @keyframes lockednVsFloat {
          0%, 100% { transform: translateY(0) scale(1); }
          50%      { transform: translateY(-3px) scale(1.018); }
        }
        @keyframes lockednVsAura {
          0%, 100% { opacity: .48; transform: scale(.92); }
          50%      { opacity: .92; transform: scale(1.12); }
        }
        @keyframes lockednVsSeam {
          0%, 100% { opacity: .28; background-position: 100% 50%; }
          48%      { opacity: .95; }
          60%      { opacity: .4; background-position: 0% 50%; }
        }
        @keyframes lockednVsOrbit {
          to { transform: rotate(360deg); }
        }
        @keyframes lockednVsType {
          0%, 100% { opacity: .58; transform: scale(1); }
          50%      { opacity: 1; transform: scale(1.035); }
        }
        @keyframes lockednVsSweep {
          0%, 15% { opacity: 0; transform: translateX(-110px); }
          32%     { opacity: .8; }
          52%     { opacity: 0; transform: translateX(170px); }
          100%    { opacity: 0; transform: translateX(170px); }
        }
        @keyframes lockednVsSpark {
          0%, 48%, 100% { opacity: 0; transform: scale(.3); }
          55%           { opacity: 1; transform: scale(1.45); }
          72%           { opacity: 0; transform: scale(.8) translateY(-4px); }
        }
        @media (prefers-reduced-motion: reduce) {
          .lockedn-vs-stage,
          .lockedn-vs-aura,
          .lockedn-vs-seam,
          .lockedn-vs-orbit,
          .lockedn-vs-type-glow,
          .lockedn-vs-sweep,
          .lockedn-vs-spark {
            animation: none !important;
          }
          .lockedn-vs-aura { opacity: .72; }
          .lockedn-vs-spark { opacity: .75; }
        }
      `}</style>
    </div>
  );
}
