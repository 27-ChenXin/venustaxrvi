at project root folder. 

# for build up of container
docker-compose up --build

# for deletion of container
docker-compose down

# or both
docker-compose down; docker-compose build; docker-compose up -d

This builds the image and starts the container on port 10003. Access it at http://localhost:10003