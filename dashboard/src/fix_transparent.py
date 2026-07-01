import re

with open("index.css", "r") as f:
    content = f.read()

content = content.replace("background-color: #080a0d;", "background-color: transparent;")
content = content.replace("background: radial-gradient(circle at 50% 0%, #111827 0%, var(--bg-primary) 70%);", "background: transparent;")

with open("index.css", "w") as f:
    f.write(content)
