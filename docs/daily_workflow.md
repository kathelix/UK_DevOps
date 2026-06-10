# Daily workflow

Note: this was initial version of the process, mostly manual. It's deprecated now and should not be used.

## Generate Post text

* open Gmail, verify that there are new emails with label "job-vacancies", and no previously processed emails, daily number is usually 20-40 emails
* run Claude, project "Job search", type: "Process again"
* see if Claude found any interesting job vacancies, apply to them
* review Post text from Claude, if unhappy continue in chat with him giving corrections
* in gmail manually delete all processed emails (current Claude MCP integration with Gmail cannot do that)
* save generated Post text

## Generate image

* run ChatGPT, project "UK DevOps"
* start new chat by typing: "Phase 1 for today's Claude post: (copy-paste Post text here)"
* ChatGPT will generate an Image, if unhappy tell ChatGPT to improve giving further instructions in the same chat
* save generated Image

## Publish to social media

Use both generated Post and Image to publish new:

* LinkedIn Post in:https://www.linkedin.com/company/uk-devops/
* Instagram Post in: https://www.instagram.com/uk_devops/
