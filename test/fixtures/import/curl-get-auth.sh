curl -u user:pass \
  -H 'Accept: application/json' \
  -H $'X-Note: it\'s a test' \
  'https://api.example.com/v1/items?x=1' \
  -F 'file=@/tmp/report.pdf;type=application/pdf' \
  -F 'name=Ada'
