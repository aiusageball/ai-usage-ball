import re

with open("App.css", "r") as f:
    content = f.read()

# Add border-radius to .pulse-desktop-environment
old = "  overflow: hidden;\n  position: relative;"
new = "  overflow: hidden;\n  position: relative;\n  border-radius: 12px;"
content = content.replace(old, new)

with open("App.css", "w") as f:
    f.write(content)
