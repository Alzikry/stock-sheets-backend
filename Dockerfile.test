FROM node:20-alpine
WORKDIR /app
RUN echo "test build" > test.txt
EXPOSE 4000
CMD ["node", "-e", "require('http').createServer((req,res)=>res.end('ok')).listen(4000)"]
