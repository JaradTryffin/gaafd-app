alter table members add constraint members_token_balance_non_negative check (token_balance >= 0);
