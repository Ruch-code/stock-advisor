#!/bin/bash
# Link Netlify site to GitHub repo
set -e
cd "$(dirname "$0")"

cat > /tmp/link_site.json << 'EOF'
{
  "site_id": "60cc8b1c-5226-40ab-9ce3-78cedb5f6d62",
  "build_settings": {
    "provider": "github",
    "repo_url": "https://github.com/Ruch-code/stock-advisor.git",
    "repo_branch": "main",
    "cmd": "echo 'Static site - no build needed'",
    "dir": ".",
    "allowed_branches": ["main"],
    "stop_builds": false
  }
}
EOF

netlify api updateSite --data "$(cat /tmp/link_site.json)" 2>&1 | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('build_settings:', json.dumps(d.get('build_settings', {}), indent=2))
print('repo:', json.dumps(d.get('repo', {}), indent=2))
print('repo_url field:', d.get('repo_url'))
"