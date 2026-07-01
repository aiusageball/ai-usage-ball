import re

with open("App.css", "r") as f:
    content = f.read()

content = content.replace(".popover-header {", ".popover-header-section {")
content = content.replace("padding: 1.5rem 2.5rem;", "padding: 1.5rem 2.5rem 1.5rem 80px;")

with open("App.css", "w") as f:
    f.write(content)
