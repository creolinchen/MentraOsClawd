import json, urllib.request
with urllib.request.urlopen('http://localhost:4040/api/requests/http') as r:
    d = json.load(r)
reqs = d.get('requests', [])
if not reqs:
    print('Keine Requests - MentraOS hat unseren Server noch nicht kontaktiert')
else:
    for x in reqs[-5:]:
        print(x["request"]["method"], x["request"]["uri"], x["response"]["status_code"])
