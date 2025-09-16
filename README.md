# Incolink Scraper Probe

## Setup

1. Create a `.env` file in the project root:

```
INCOLINK_EMAIL=your@email
INCOLINK_PASSWORD=yourpassword
# Optional default employer number
INCOLINK_EMPLOYER_NO=7125150
```

2. Install dependencies:

```
pm install
```

## Run

- One-off probe with explicit employer number:

```
npx tsx scripts/incolink_probe.ts 7125150
```

- Or using package script:

```
npm run probe -- 7125150
```

Downloads will be written to `tmp/incolink/`.