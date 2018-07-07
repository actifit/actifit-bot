# Community Bot - Voting bot for communities on Steem!

This is a voting bot for communities on the Steem platform. Members of the community can all chip in to power up the bot which will then go through the list of members and upvote the latest post by each. 

## Installation
```
$ npm install
```

## Configuration
First rename config-example.json to config.json:
```
$ mv config-example.json config.json
```

Then set the following options in config.json:
```
{
  "disabled_mode": false,
  "testing": true,
  "detailed_logging": false,
  "account": "actifit",
  "main_tag": "actifit",
  "memo_key": "your_private_memo_key",
  "posting_key": "your_private_posting_key",
  "active_key": "your_private_active_key",
  "auto_claim_rewards" : true,
  "vote_weight": 100000,
  "min_hours": 24,
  "comment_location": "comment.md",
  "comment": false,
  "resteem": false,
  "no_paid_bots": true,
  "beneficiaries": ["actifit", "actifit.pay"],
  "flag_signal_accounts": ["spaminator", "cheetah", "steemcleaners", "mack-bot"],
  "report_emails": "urucrypto@gmail.com",
  "smtp_usr": "SMTP USERNAME",
  "smtp_from": "'From Name' <from@domain.domain>",
  "smtp_key": "key"
}
```
## Run
```
$ npm run all
```

This will run the process in the foreground which is not recommended. We recommend using a tool such as [PM2](http://pm2.keymetrics.io/) to run the process in the background as well as providing many other great features.

### To run each service apart

```
$ npm run api
$ npm run import
$ npm run curate
```
