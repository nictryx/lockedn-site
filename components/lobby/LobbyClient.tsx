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
                Tap the lock icon in the URL bar → Permissions → Camera → Allow
              </div>
              <div>
                <div style={{ color: COLORS.text3, fontSize: 11, marginBottom: 4,
                              textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
                  Safari / iPhone
                </div>
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
    <div style={{
      position: "absolute", top: "50%", left: "50%",
      transform: "translate(-50%, -50%)",
      zIndex: 20, pointerEvents: "none",
    }}>
      {/* Outer glow rings */}
      <div style={{
        position: "absolute", inset: -20,
        borderRadius: "50%",
        background: "radial-gradient(circle, rgba(48,209,88,0.25) 0%, transparent 65%)",
        animation: "vsGlow 2.4s ease-in-out infinite",
      }}/>

      {/* Diamond/hexagon container */}
      <div style={{
        position: "relative",
        width: 84, height: 84,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {/* Rotating rim */}
        <div style={{
          position: "absolute", inset: 0,
          background: "conic-gradient(from 0deg, #30D158, transparent 30%, transparent 55%, #30D158 65%, transparent 90%)",
          borderRadius: 20,
          animation: "vsRotate 4s linear infinite",
          opacity: 0.7,
        }}/>

        {/* Inner black diamond */}
        <div style={{
          position: "absolute", inset: 2,
          background: "linear-gradient(145deg, #0a0a0a 0%, #1a1a1a 100%)",
          borderRadius: 18,
          border: "1px solid rgba(48,209,88,0.4)",
          boxShadow: "inset 0 0 20px rgba(48,209,88,0.15), 0 0 30px rgba(0,0,0,0.6)",
        }}/>

        {/* Grid pattern overlay */}
        <div style={{
          position: "absolute", inset: 4, borderRadius: 16,
          backgroundImage: `
            linear-gradient(rgba(48,209,88,0.05) 1px, transparent 1px),
            linear-gradient(90deg, rgba(48,209,88,0.05) 1px, transparent 1px)
          `,
          backgroundSize: "8px 8px",
          overflow: "hidden",
        }}/>

        {/* VS text */}
        <div style={{
          position: "relative",
          fontSize: 34, fontWeight: 900,
          letterSpacing: -1.5,
          fontFamily: SYSTEM_FONT,
          background: "linear-gradient(180deg, #FFFFFF 0%, #B8F5C8 60%, #30D158 100%)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          backgroundClip: "text",
          filter: "drop-shadow(0 0 12px rgba(48,209,88,0.6))",
          animation: "vsPulse 1.6s ease-in-out infinite",
        }}>
          VS
        </div>

        {/* Bottom shine sweep */}
        <div style={{
          position: "absolute", inset: 4, borderRadius: 16,
          background: "linear-gradient(115deg, transparent 40%, rgba(255,255,255,0.15) 50%, transparent 60%)",
          animation: "vsShine 3s ease-in-out infinite",
          pointerEvents: "none",
        }}/>
      </div>

      <style>{`
        @keyframes vsPulse {
          0%, 100% { transform: scale(1);    filter: drop-shadow(0 0 12px rgba(48,209,88,0.6)); }
          50%      { transform: scale(1.06); filter: drop-shadow(0 0 18px rgba(48,209,88,0.9)); }
        }
        @keyframes vsGlow {
          0%, 100% { opacity: 0.5; transform: scale(1);    }
          50%      { opacity: 1;   transform: scale(1.15); }
        }
        @keyframes vsRotate {
          from { transform: rotate(0deg);   }
          to   { transform: rotate(360deg); }
        }
        @keyframes vsShine {
          0%   { transform: translateX(-100%); }
          60%  { transform: translateX(100%);  }
          100% { transform: translateX(100%);  }
        }
      `}</style>
    </div>
  );
}
