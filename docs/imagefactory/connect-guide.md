# Connect ImageFactory to Claude and ChatGPT

ImageFactory makes on-brand images when you ask your AI assistant for them. You add it once as a
connector, save your brand, then ask in plain words. Every image comes back with a public link that works in
Pinterest, a blog post or an automation.

The connector URL is shown on your [account page](https://imagefactory.zhst.app/account):

```
https://imagefactory.zhst.app/mcp
```

> **Verification status.** The sign-in flow, the tools and the image reply are covered by automated tests
> against the app's own code. They have not yet been run from a real Claude or ChatGPT account against the
> deployed site. The "Verified" column below is filled in after that check (see the deploy guide, section 7).

| Client | Added how | Verified |
|---|---|---|
| Claude on the web | Settings, Connectors, Add custom connector | not yet |
| Claude Chrome extension | Uses the connectors on your Claude account | not yet |
| Claude Desktop | Syncs from your Claude account | not yet |
| ChatGPT | Settings, Apps & Connectors, developer mode, add an MCP server | not yet |
| n8n (HTTP Request node, MCP Client node) | API key | not yet |
| Make (HTTP module) | API key | not yet |

## Claude (web, Chrome extension, Desktop)

1. Open Settings, then Connectors, then **Add custom connector**.
2. Paste the connector URL. If Claude asks how to identify itself, choose to register automatically.
3. Claude opens ImageFactory. Sign in with your email link or Google, check the app name and the address it will
   return to, and choose **Allow**.
4. In a conversation, turn the connector on and ask for images. The Chrome extension and Claude Desktop use the
   same connector once it is on your account.

## ChatGPT

1. Settings, Apps & Connectors, then turn on developer mode.
2. Add a connector: paste the same URL and choose OAuth.
3. Sign in and choose **Allow**, then enable the connector in a chat.

Whether ChatGPT shows the image inline or only the link is recorded after the first real test. The reply always
contains the link and a markdown image, so there is something to open either way.

## Make your first images

Ask your assistant to set up a brand kit, then use it:

> Create a brand kit called "LargePrint Puzzles" from https://largeprint.zhst.app. Friendly flat illustration,
> thick outlines, warm paper background, a bold rounded title font. Add the site's logo as a reference.

> Make 3 Pinterest pins for a large-print word search book about birds, using the LargePrint Puzzles brand.
> Put "Big Bird Search" on the first one.

Reference images are the strongest way to keep a series consistent. When you get a result you love, say
"add that image to the brand as a reference" (this stores a private copy) and ask for the next batch.

## Recipes

**Pinterest pin series.** "Make 5 pins for [topic], brand [name], preset pin. Different scene each time." Pins are
2:3 and cost 4 credits each by default.

**Blog hero and social preview.** "Make a blog hero for a post called [title], preset blog_hero." The same image
works as the social preview.

**Book cover concepts for KDP.** "Make 4 cover concepts for [title], preset cover_6x9." These are concepts, not
print files: the size is 1024x1536, below the 300 DPI a KDP print cover needs, and diffusion models misspell long
titles. Keep any on-image text to a few words and add the real title in a design tool.

**Variations on a winner.** "Take that second pin and make 10 variations in the same style." This uses `edit_image`
with the image as the reference.

**Know the cost first.** "How much would 12 square images cost, and what's my balance?"

## What things cost

One credit is one US cent. Each started megapixel is charged, so these are the defaults (the owner can change
them):

| Preset | Size | Generate | Edit with references |
|---|---|---|---|
| pin | 816x1224 | 4 credits | 6 credits |
| pin_hd | 1152x1728 | 8 credits | 12 credits |
| square | 992x992 | 4 credits | 6 credits |
| blog_hero | 1280x720 | 4 credits | 6 credits |
| cover_6x9 | 1024x1536 | 8 credits | 12 credits |

Credits are reserved when a job starts and charged only for images that arrive. A failed job, or an image the
safety check blocks, costs nothing. Credits are added by the account owner; there is no checkout.

## Automating with n8n, Make or Postiz

Create an API key on your account page. Read and write keys can make images; read-only keys can only list.

**HTTP call (n8n HTTP Request node, Make HTTP module):**

```
POST https://imagefactory.zhst.app/api/v1/images/generate
Authorization: Bearer if_live_...
Content-Type: application/json

{ "prompt": "A watercolor robin on a branch", "brand": "largeprint-puzzles", "preset": "pin", "num_images": 1 }
```

The answer lists each image with its `url`. Pass that URL straight to a Postiz or Pinterest step. Add
`?wait=false` to get a `job_id` immediately and poll `GET /api/v1/jobs/{job_id}`; without it the call waits up to 45
seconds.

**MCP (n8n MCP Client node):** point it at `https://imagefactory.zhst.app/mcp` and send the same key as a bearer
token. The tools are the ones your assistant sees.

## Good to know

- **Public links.** Anyone with an image's link can open it. The links are long and random but not private. Ask
  your assistant to delete an image and its link stops working for new visitors; a browser, CDN or Pinterest may keep a copy it already fetched.
- **Text.** Models misspell long text. Keep on-image text to a few words.
- **Revoking.** Disconnect an app or revoke a key on the account page. The next request from it fails and asks to
  sign in again.
- **Limits.** Up to 4 images per request, 30 requests a minute per account, 25 brand kits, 12 reference images per
  brand.
