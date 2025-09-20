import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import config from '../config';
import './CloudflareVideoCall.css';

const CloudflareVideoCall = ({ callId, user, onEndCall }) => {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [peerConnection, setPeerConnection] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [timeLeft, setTimeLeft] = useState(600); // 10 minutes
  const [sessionStarted, setSessionStarted] = useState(false);

  const localVideoRef = useRef();
  const remoteVideoRef = useRef();
  const dataChannelRef = useRef();
  const socketRef = useRef();
  const pcRef = useRef();

  const CLOUDFLARE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: 'turn:turn.cloudflare.com:3478',
        username: 'ccb11479d57e58d6450a4743bad9a1e8',
        credential: '75063d2f78527ff8115025d127e87619d62c4428ed6ff1b001fc3cf03d0ba514'
      }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  };

  useEffect(() => {
    initializeCall();
    return () => {
      cleanup();
    };
  }, []);

  useEffect(() => {
    if (sessionStarted && timeLeft > 0) {
      const timer = setInterval(() => {
        setTimeLeft(prev => {
          if (prev <= 1) {
            handleEndCall();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [sessionStarted, timeLeft]);

  const initializeCall = async () => {
    try {
      // Get user media with better constraints
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      
      setLocalStream(stream);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      // Create peer connection
      const pc = new RTCPeerConnection(CLOUDFLARE_CONFIG);
      
      // Add local stream to peer connection
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
      });

      // Handle remote stream
      pc.ontrack = (event) => {
        const [remoteStream] = event.streams;
        setRemoteStream(remoteStream);
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = remoteStream;
        }
      };

      // Handle connection state
      pc.onconnectionstatechange = () => {
        console.log('Connection state:', pc.connectionState);
        setIsConnected(pc.connectionState === 'connected');
        if (pc.connectionState === 'connected' && !sessionStarted) {
          setSessionStarted(true);
          startSession();
        }
        if (pc.connectionState === 'failed') {
          console.error('WebRTC connection failed');
          alert('Connection failed. Please try again.');
        }
      };
      
      // Handle ICE connection state
      pc.oniceconnectionstatechange = () => {
        console.log('ICE connection state:', pc.iceConnectionState);
      };

      // Create data channel for chat (only for mentor)
      if (user.role === 'mentor') {
        const dataChannel = pc.createDataChannel('chat');
        dataChannel.onopen = () => {
          console.log('Data channel opened');
        };
        dataChannel.onmessage = (event) => {
          const message = JSON.parse(event.data);
          setMessages(prev => [...prev, message]);
        };
        dataChannelRef.current = dataChannel;
      }

      // Handle incoming data channel (for mentee)
      pc.ondatachannel = (event) => {
        console.log('Received data channel');
        const channel = event.channel;
        channel.onopen = () => {
          console.log('Incoming data channel opened');
        };
        channel.onmessage = (event) => {
          const message = JSON.parse(event.data);
          setMessages(prev => [...prev, message]);
        };
        dataChannelRef.current = channel;
      };

      setPeerConnection(pc);

      // Start signaling
      await handleSignaling(pc);

    } catch (error) {
      console.error('Failed to initialize call:', error);
      alert('Failed to access camera/microphone. Please check permissions.');
    }
  };

  const handleSignaling = async (pc) => {
    try {
      // Create single Socket.IO connection
      const socket = io(config.API_BASE_URL);
      socketRef.current = socket;
      pcRef.current = pc;
      
      console.log(`${user.role} joining call ${callId}`);
      
      // Join both user room and call room
      socket.emit('join_user_room', user.id);
      socket.emit('join_call', callId);
      
      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('Sending ICE candidate:', event.candidate);
          socket.emit('webrtc_ice_candidate', {
            callId,
            candidate: event.candidate,
            userId: user.id
          });
        }
      };
      
      // Handle WebRTC signaling via Socket.IO
      socket.on('webrtc_offer', async (data) => {
        console.log('Received offer:', data);
        if (data.callId == callId && user.role === 'mentee') {
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            
            console.log('Sending answer:', answer);
            socket.emit('webrtc_answer', {
              callId,
              answer,
              userId: user.id
            });
          } catch (error) {
            console.error('Error handling offer:', error);
          }
        }
      });
      
      socket.on('webrtc_answer', async (data) => {
        console.log('Received answer:', data);
        if (data.callId == callId && user.role === 'mentor') {
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          } catch (error) {
            console.error('Error handling answer:', error);
          }
        }
      });
      
      socket.on('webrtc_ice_candidate', async (data) => {
        console.log('Received ICE candidate:', data);
        if (data.callId == callId && data.userId !== user.id) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (error) {
            console.error('Error adding ICE candidate:', error);
          }
        }
      });
      
      // Create offer if mentor (after a small delay to ensure both are connected)
      if (user.role === 'mentor') {
        setTimeout(async () => {
          try {
            console.log('Creating offer...');
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            
            console.log('Sending offer:', offer);
            socket.emit('webrtc_offer', {
              callId,
              offer,
              userId: user.id
            });
          } catch (error) {
            console.error('Error creating offer:', error);
          }
        }, 1000);
      }
      
    } catch (error) {
      console.error('Signaling error:', error);
    }
  };



  const startSession = async () => {
    try {
      await axios.post(`${config.API_BASE_URL}/video-call/${callId}/start`, {
        userId: user.id
      });
    } catch (error) {
      console.error('Failed to start session:', error);
    }
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
        const sender = peerConnection.getSenders().find(s => 
          s.track && s.track.kind === 'video'
        );
        
        if (sender) {
          await sender.replaceTrack(videoTrack);
        }
        
        videoTrack.onended = () => {
          stopScreenShare();
        };
        
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
      const sender = peerConnection.getSenders().find(s => 
        s.track && s.track.kind === 'video'
      );
      
      if (sender && videoTrack) {
        await sender.replaceTrack(videoTrack);
      }
    }
    setIsScreenSharing(false);
  };

  const sendMessage = () => {
    if (newMessage.trim() && dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
      const message = {
        text: newMessage,
        sender: user.username,
        timestamp: new Date().toLocaleTimeString()
      };
      
      try {
        dataChannelRef.current.send(JSON.stringify(message));
        setMessages(prev => [...prev, message]);
        setNewMessage('');
      } catch (error) {
        console.error('Failed to send message:', error);
      }
    }
  };

  const handleEndCall = async () => {
    try {
      await axios.post(`${config.API_BASE_URL}/video-call/${callId}/end`, {
        userId: user.id
      });
      cleanup();
      onEndCall();
    } catch (error) {
      console.error('Failed to end call:', error);
      cleanup();
      onEndCall();
    }
  };

  const cleanup = () => {
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    if (pcRef.current) {
      pcRef.current.close();
    }
    if (socketRef.current) {
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
              Waiting for other participant...
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
          >
            {isMuted ? '🔇' : '🎤'}
          </button>
          
          <button 
            onClick={toggleVideo}
            className={`control-btn ${isVideoOff ? 'video-off' : ''}`}
          >
            {isVideoOff ? '📹' : '📷'}
          </button>
          
          <button 
            onClick={toggleScreenShare}
            className={`control-btn ${isScreenSharing ? 'sharing' : ''}`}
          >
            🖥️
          </button>
          
          <button onClick={handleEndCall} className="control-btn end-call">
            📞
          </button>
        </div>
      </div>

      <div className="chat-panel">
        <div className="chat-messages">
          {messages.map((msg, index) => (
            <div key={index} className="chat-message">
              <span className="sender">{msg.sender}:</span>
              <span className="text">{msg.text}</span>
              <span className="time">{msg.timestamp}</span>
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
          />
          <button onClick={sendMessage}>Send</button>
        </div>
      </div>
    </div>
  );
};

export default CloudflareVideoCall;