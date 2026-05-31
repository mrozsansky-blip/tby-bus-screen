# TBY Bus Screen

Custom student bus display for Tiferes Bais Yaakov, backed by Airtable.

## Pages

After deploying, the app has three display pages:

- `/from-school` - regular From School dismissal routes
- `/pri-dismissal` - PRI dismissal routes
- `/friday-dismissal` - Friday dismissal routes

Each page reads the `Bus routes` table in Airtable and shows large color-coded tiles.

## Render setup

Create a new Render **Web Service** connected to this GitHub repository.

Use these settings:

- Runtime: `Node`
- Build command: `npm install`
- Start command: `npm start`

## Environment variables

Add these in Render, not in GitHub:

```text
AIRTABLE_TOKEN=your Airtable personal access token
AIRTABLE_BASE_ID=appEoktGjwEeUP9GX
AIRTABLE_TABLE_NAME=Bus routes
```

Optional environment variables if you rename fields in Airtable:

```text
FIELD_NAME_BUS_NAME=Student Bus Screen Name
FIELD_NAME_STATUS=Current Student Screen Status
FIELD_NAME_SPOT=Current Parking Spot
FIELD_NAME_ORDER=Student Bus Screen Order
FIELD_NAME_WORKFLOW=Route Workflow Type
FIELD_NAME_FRIDAY=Use for Friday Dismissal
CACHE_SECONDS=10
```

## Airtable fields used

The app expects these fields in the `Bus routes` table:

- `Student Bus Screen Name`
- `Current Student Screen Status`
- `Current Parking Spot`
- `Student Bus Screen Order`
- `Route Workflow Type`
- `Use for Friday Dismissal`

## Airtable filters

The pages use these filters:

- From School: `Route Workflow Type = From School Dismissal`
- PRI Dismissal: `Route Workflow Type = PRI Dismissal`
- Friday Dismissal: `Use for Friday Dismissal` is checked

## Status colors

- Waiting: gray
- Arrived: yellow
- Loading: blue
- Ready to Board: green
- Departed: dark gray
- Delayed: orange
- Cancelled: red

## Local development

```bash
npm install
AIRTABLE_TOKEN=your_token npm start
```

Then open:

```text
http://localhost:3000/from-school
```
