import re

with open("App.css", "r") as f:
    content = f.read()

# Revert .video-blob back to Flexbox sizing
old_css = """.video-blob {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 142%;
  height: 142%;"""
new_css = """.video-blob {
  width: 140%;
  height: 140%;"""

content = content.replace(old_css, new_css)

# Remove position: relative from .video-hover-wrapper
old_wrapper = """.video-hover-wrapper {
  position: relative;"""
new_wrapper = """.video-hover-wrapper {"""

content = content.replace(old_wrapper, new_wrapper)

with open("App.css", "w") as f:
    f.write(content)
