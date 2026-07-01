import re

with open("App.jsx", "r") as f:
    content = f.read()

# Change all 0.1 to 0.5 in App.jsx
content = content.replace("0.1", "0.5")

with open("App.jsx", "w") as f:
    f.write(content)
