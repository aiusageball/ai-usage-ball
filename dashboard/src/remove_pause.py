import re

with open("App.jsx", "r") as f:
    content = f.read()

# Remove pause from mount effect
old_mount = """      if (!isCriticalRef.current) {
        try {
          videoRef.current.playbackRate = 0;
        } catch (e) {}
        videoRef.current.pause();
      } else {"""

new_mount = """      if (!isCriticalRef.current) {
        try {
          videoRef.current.playbackRate = 0.1;
        } catch (e) {}
      } else {"""
content = content.replace(old_mount, new_mount)

# Remove pause from loop
old_loop = """        if (appliedSpeed < 0.05 && targetSpeedRef.current === 0) {
          appliedSpeed = 0;
          if (!videoRef.current.paused) {
            videoRef.current.pause();
          }
        } else {
          if (videoRef.current.paused) {
            videoRef.current.play().catch(() => {});
          }
          // Browsers typically require playbackRate >= 0.0625
          try {
            videoRef.current.playbackRate = Math.max(0.065, appliedSpeed);
          } catch (e) {
            // Silence playbackRate errors during dynamic reload loading states
          }
        }"""

new_loop = """        if (appliedSpeed < 0.1 && targetSpeedRef.current === 0) {
          appliedSpeed = 0.1;
        }
        
        // NEVER pause. Just clamp the speed to 0.1 to keep the engine running
        try {
          // If it somehow got paused by the OS, try to wake it up
          if (videoRef.current.paused) {
            videoRef.current.play().catch(() => {});
          }
          videoRef.current.playbackRate = Math.max(0.1, appliedSpeed);
        } catch (e) {
        }"""
content = content.replace(old_loop, new_loop)

# Remove play from handleInteraction
old_handle = """    if (videoRef.current && videoRef.current.paused) {
      videoRef.current.play().catch(e => console.error("Direct play blocked:", e));
    }"""
new_handle = """    // We do not force play here, the loop handles it"""
content = content.replace(old_handle, new_handle)


with open("App.jsx", "w") as f:
    f.write(content)
