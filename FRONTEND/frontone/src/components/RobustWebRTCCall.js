import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import config from '../config';
import './CloudflareVideoCall.css';

const RobustWebRTCCall = ({ callId, user, onEndCall }) => {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [timeLeft, setTimeLeft] = useState(600);
  const [connectionState, setConnectionState] = useState('connecting');

  const localVideoRef = useRef();
  const remoteVideoRef = useRef();
  const peerConnectionRef = useRef();
  const socketRef = useRef();
  const dataChannelRef = useRef();
  const timerRef = useRef();

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: 'turn:turn.cloudflare.com:3478',
      username: 'ccb11479d57e58d6450a4743bad9a1e8',
      credential: '75063d2f78527ff8115025d127e87619d62c4428ed6ff1b001fc3cf03d0ba514'
    }
  ];

  useEffect(() => {
    initializeCall();
    return cleanup;
  }, []);

  useEffect(() => {
    if (isConnected && !timerRef.current) {
      startTimer();
    }
  }, [isConnected]);

  const initializeCall = async () => {
    try {
      console.log(`🚀 Initializing call ${callId} for ${user.role}`);
      
      // Stop any existing streams first
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
      }
      
      // Get user media with fallback constraints
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720 },
          audio: { echoCancellation: true, noiseSuppression: true }
        });
      } catch (error) {
        console.warn('HD constraints failed, trying basic:', error);
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true
        });
      }
      
      setLocalStream(stream);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      // Create peer connection
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peerConnectionRef.current = pc;

      // Add tracks
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      // Handle remote stream
      pc.ontrack = (event) => {
        console.log('📺 Remote stream received');
        const [stream] = event.streams;
        setRemoteStream(stream);
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = stream;
        }
      };

      // Connection state monitoring with detailed logging
      pc.onconnectionstatechange = () => {
        console.log(`🔗 ${user.role} Connection state changed:`, pc.connectionState);
        setConnectionState(pc.connectionState);
        
        if (pc.connectionState === 'connected') {
          console.log(`✅ 🎉 ${user.role.toUpperCase()} SUCCESSFULLY CONNECTED!`);
          setIsConnected(true);
        } else if (pc.connectionState === 'failed') {
          console.error(`❌ ${user.role} WebRTC connection FAILED`);
          setIsConnected(false);
        } else if (pc.connectionState === 'disconnected') {
          console.log(`🔌 ${user.role} WebRTC disconnected`);
          setIsConnected(false);
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log(`🧊 ${user.role} ICE connection state:`, pc.iceConnectionState);
        
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          console.log(`✅ ${user.role} ICE connection established!`);
        } else if (pc.iceConnectionState === 'failed') {
          console.error(`❌ ${user.role} ICE connection failed!`);
        }
      };

      // Setup Socket.IO
      await setupSocket(pc);

      // Setup data channel
      setupDataChannel(pc);

    } catch (error) {
      console.error('❌ Failed to initialize call:', error);
      if (error.name === 'NotReadableError') {
        alert('Camera/microphone is being used by another application. Please close other video apps and try again.');
      } else {
        alert('Failed to access camera/microphone. Please check permissions and try again.');
      }
    }
  };

  const setupSocket = async (pc) => {
    return new Promise((resolve, reject) => {
      const socket = io(config.SOCKET_URL, {
        transports: ['polling', 'websocket'],
        timeout: 15000,
        forceNew: true,
        reconnection: false
      });

      socketRef.current = socket;

      socket.on('connect', () => {
        console.log(`✅ ${user.role} socket connected for call ${callId}`);
        
        // Join rooms with delay to ensure server processing
        setTimeout(() => {
          socket.emit('join_user_room', user.id);
          socket.emit('join_call', callId);
          console.log(`🏠 ${user.role} joined rooms: user_${user.id}, call_${callId}`);
          setupSignaling(pc, socket);
          resolve();
        }, 500);
      });

      socket.on('connect_error', (error) => {
        console.error('❌ Socket connection failed:', error);
        reject(error);
      });
      
      socket.on('disconnect', (reason) => {
        console.log(`🔌 ${user.role} socket disconnected:`, reason);
      });
    });
  };

  const setupSignaling = (pc, socket) => {
    console.log(`🔌 Setting up signaling for ${user.role} in call ${callId}`);
    
    // ICE candidates with detailed logging
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`🧊 ${user.role} sending ICE candidate:`, event.candidate.type);
        socket.emit('ice_candidate', {
          callId,
          candidate: event.candidate,
          from: user.id,
          role: user.role
        });
      } else {
        console.log(`🧊 ${user.role} ICE gathering complete`);
      }
    };

    // Detailed connection state logging
    pc.oniceconnectionstatechange = () => {
      console.log(`🧊 ${user.role} ICE connection state: ${pc.iceConnectionState}`);
    };
    
    pc.onicegatheringstatechange = () => {
      console.log(`🧊 ${user.role} ICE gathering state: ${pc.iceGatheringState}`);
    };
    
    pc.onsignalingstatechange = () => {
      console.log(`📡 ${user.role} signaling state: ${pc.signalingState}`);
    };

    // Participant tracking
    socket.on('participant_joined', (data) => {
      console.log(`👥 Participant joined call ${data.callId}, total: ${data.participantCount}`);
      if (data.participantCount >= 2 && user.role === 'mentor') {
        console.log('📤 Both participants ready, mentor will create offer in 3 seconds...');
      }
    });

    // Handle signaling events with detailed logging
    socket.on('offer', async (data) => {
      console.log(`📨 ${user.role} received offer from user ${data.from} for call ${data.callId}`);
      console.log('Offer details:', { callId: data.callId, from: data.from, myId: user.id, myRole: user.role });
      
      if (data.callId == callId && data.from !== user.id && user.role === 'mentee') {
        console.log('📨 ✅ Mentee processing offer...');
        try {
          console.log('📨 Setting remote description...');
          await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
          console.log('📨 Creating answer...');
          const answer = await pc.createAnswer();
          console.log('📨 Setting local description...');
          await pc.setLocalDescription(answer);
          console.log('📤 Sending answer...');
          socket.emit('answer', { callId, answer, from: user.id, role: user.role });
          console.log('✅ Answer sent successfully');
        } catch (error) {
          console.error('❌ Error handling offer:', error);
        }
      } else {
        console.log('📨 ❌ Ignoring offer - not for this mentee or wrong role');
      }
    });

    socket.on('answer', async (data) => {
      console.log(`📨 ${user.role} received answer from user ${data.from} for call ${data.callId}`);
      console.log('Answer details:', { callId: data.callId, from: data.from, myId: user.id, myRole: user.role });
      
      if (data.callId == callId && data.from !== user.id && user.role === 'mentor') {
        console.log('📨 ✅ Mentor processing answer...');
        try {
          console.log('📨 Setting remote description from answer...');
          await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          console.log('✅ Answer processed successfully - WebRTC connection should establish');
        } catch (error) {
          console.error('❌ Error handling answer:', error);
        }
      } else {
        console.log('📨 ❌ Ignoring answer - not for this mentor or wrong role');
      }
    });

    socket.on('ice_candidate', async (data) => {
      console.log(`🧊 ${user.role} received ICE candidate from ${data.role} (user ${data.from})`);
      if (data.callId == callId && data.from !== user.id) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          console.log(`✅ ICE candidate added successfully`);
        } catch (error) {
          console.error('❌ ICE candidate error:', error);
        }
      }
    });

    // Chat messages with logging
    socket.on('chat_message', (data) => {
      if (data.callId == callId && data.from !== user.id) {
        console.log('💬 Received chat message from:', data.from);
        setMessages(prev => [...prev, data.message]);
      }
    });

    // Timer sync
    socket.on('timer_sync', (data) => {
      if (data.callId == callId && data.from !== user.id) {
        console.log('⏱️ Timer sync received:', data.timeLeft);
        setTimeLeft(data.timeLeft);
      }
    });

    // Start signaling if mentor (wait for both to join)
    if (user.role === 'mentor') {
      console.log('📤 Mentor will create offer in 3 seconds...');
      setTimeout(async () => {
        try {
          console.log('📤 🚀 MENTOR CREATING OFFER NOW...');
          console.log('PC signaling state before offer:', pc.signalingState);
          console.log('PC connection state before offer:', pc.connectionState);
          
          const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
          });
          
          console.log('📤 Offer created, setting local description...');
          await pc.setLocalDescription(offer);
          
          console.log('📤 Local description set, sending offer...');
          console.log('Offer SDP preview:', offer.sdp.substring(0, 100) + '...');
          
          socket.emit('offer', { 
            callId, 
            offer, 
            from: user.id, 
            role: user.role,
            timestamp: Date.now()
          });
          
          console.log('✅ 📤 OFFER SENT SUCCESSFULLY TO MENTEE!');
        } catch (error) {
          console.error('❌ 📤 FAILED TO CREATE/SEND OFFER:', error);
        }
      }, 3000);
    } else {
      console.log('📨 Mentee waiting for offer from mentor...');
    }
  };

  const setupDataChannel = (pc) => {
    if (user.role === 'mentor') {
      const channel = pc.createDataChannel('chat', { ordered: true });
      channel.onopen = () => console.log('💬 Data channel opened');
      channel.onmessage = (event) => {
        const message = JSON.parse(event.data);
        setMessages(prev => [...prev, message]);
      };
      dataChannelRef.current = channel;
    }

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.onopen = () => console.log('💬 Data channel received');
      channel.onmessage = (event) => {
        const message = JSON.parse(event.data);
        setMessages(prev => [...prev, message]);
      };
      dataChannelRef.current = channel;
    };
  };

  const startTimer = () => {
    timerRef.current = setInterval(() => {
      setTimeLeft(prev => {
        const newTime = prev - 1;
        
        // Sync timer every 10 seconds
        if (newTime % 10 === 0 && socketRef.current) {
          socketRef.current.emit('timer_sync', {
            callId,
            timeLeft: newTime,
            from: user.id
          });
        }
        
        if (newTime <= 0) {
          handleEndCall();
          return 0;
        }
        return newTime;
      });
    }, 1000);
  };

  const toggleMute = () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoOff(!videoTrack.enabled);
      }
    }
  };

  const toggleScreenShare = async () => {
    try {
      if (!isScreenSharing) {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true
        });
        
        const videoTrack = screenStream.getVideoTracks()[0];
        const sender = peerConnectionRef.current.getSenders().find(s => 
          s.track && s.track.kind === 'video'
        );
        
        if (sender) {
          await sender.replaceTrack(videoTrack);
        }
        
        videoTrack.onended = () => stopScreenShare();
        setIsScreenSharing(true);
      } else {
        stopScreenShare();
      }
    } catch (error) {
      console.error('Screen share error:', error);
    }
  };

  const stopScreenShare = async () => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      const sender = peerConnectionRef.current.getSenders().find(s => 
        s.track && s.track.kind === 'video'
      );
      
      if (sender && videoTrack) {
        await sender.replaceTrack(videoTrack);
      }
    }
    setIsScreenSharing(false);
  };

  const sendMessage = () => {
    if (newMessage.trim()) {
      const message = {
        text: newMessage,
        sender: user.username,
        timestamp: new Date().toLocaleTimeString(),
        from: user.id
      };

      console.log(`💬 ${user.role} sending message:`, message.text);
      
      let sentViaDataChannel = false;
      let sentViaSocket = false;

      // Try data channel first
      if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
        try {
          dataChannelRef.current.send(JSON.stringify(message));
          console.log('✅ Message sent via data channel');
          sentViaDataChannel = true;
        } catch (error) {
          console.error('❌ Data channel send failed:', error);
        }
      } else {
        console.log('❌ Data channel not available, state:', dataChannelRef.current?.readyState);
      }

      // Send via socket (always as backup)
      if (socketRef.current && socketRef.current.connected) {
        try {
          socketRef.current.emit('chat_message', {
            callId,
            message,
            from: user.id,
            role: user.role
          });
          console.log('✅ Message sent via socket');
          sentViaSocket = true;
        } catch (error) {
          console.error('❌ Socket send failed:', error);
        }
      } else {
        console.log('❌ Socket not connected');
      }
      
      if (!sentViaDataChannel && !sentViaSocket) {
        console.error('❌ Message failed to send via both channels!');
        alert('Message failed to send. Connection issue.');
        return;
      }

      setMessages(prev => [...prev, message]);
      setNewMessage('');
    }
  };

  const handleEndCall = async () => {
    try {
      await axios.post(`${config.API_BASE_URL}/video-call/${callId}/end`, {
        userId: user.id
      });
    } catch (error) {
      console.error('Failed to end call:', error);
    }
    cleanup();
    onEndCall();
  };

  const cleanup = () => {
    console.log('🧹 Cleaning up call resources');
    
    if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
    }
    
    if (socketRef.current) {
      socketRef.current.emit('leave_call', callId);
      socketRef.current.disconnect();
    }
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="cloudflare-video-call">
      <div className="video-container">
        <div className="remote-video">
          <video ref={remoteVideoRef} autoPlay playsInline />
          {!remoteStream && (
            <div className="waiting-message">
              <div>Waiting for other participant...</div>
              <div className="connection-status">
                Status: {connectionState}
              </div>
            </div>
          )}
        </div>
        
        <div className="local-video">
          <video ref={localVideoRef} autoPlay playsInline muted />
        </div>
      </div>

      <div className="call-controls">
        <div className="timer">
          <span className={timeLeft < 60 ? 'warning' : ''}>
            {formatTime(timeLeft)}
          </span>
        </div>

        <div className="control-buttons">
          <button 
            onClick={toggleMute}
            className={`control-btn ${isMuted ? 'muted' : ''}`}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? '🔇' : '🎤'}
          </button>
          
          <button 
            onClick={toggleVideo}
            className={`control-btn ${isVideoOff ? 'video-off' : ''}`}
            title={isVideoOff ? 'Turn on video' : 'Turn off video'}
          >
            {isVideoOff ? '📹' : '📷'}
          </button>
          
          <button 
            onClick={toggleScreenShare}
            className={`control-btn ${isScreenSharing ? 'sharing' : ''}`}
            title={isScreenSharing ? 'Stop sharing' : 'Share screen'}
          >
            🖥️
          </button>
          
          <button 
            onClick={handleEndCall} 
            className="control-btn end-call"
            title="End call"
          >
            📞
          </button>
        </div>
      </div>

      <div className="chat-panel">
        <div className="chat-header">
          <h4>Chat</h4>
          <span className="connection-indicator">
            {isConnected ? '🟢 Connected' : '🔴 Connecting...'}
          </span>
        </div>
        
        <div className="chat-messages">
          {messages.map((msg, index) => (
            <div key={index} className="chat-message">
              <div className="message-header">
                <span className="sender">{msg.sender}</span>
                <span className="time">{msg.timestamp}</span>
              </div>
              <div className="message-text">{msg.text}</div>
            </div>
          ))}
        </div>
        
        <div className="chat-input">
          <input
            type="text"
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
            placeholder="Type a message..."
            disabled={!isConnected}
          />
          <button 
            onClick={sendMessage}
            disabled={!newMessage.trim() || !isConnected}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
};

export default RobustWebRTCCall;