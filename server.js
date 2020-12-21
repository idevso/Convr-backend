const express = require("express");
const app = express();
const cors = require("cors");
const mysqlx = require("@mysql/xdevapi");
const { DbContext } = require("mysqlconnector");
const { errorMonitor } = require("stream");
const connection = {user : "root", password : "dream", port : 1721};
const server = require("http").createServer(app);

const io = require("socket.io")(server, {
    cors : {
        origin : "*"
    },
    methods: ["GET", "POST"],
    credentials : true
});

app.use(express.json({type : "application/x-www-form-urlencoded"}));
app.use(cors());
app.use(express.urlencoded({extended : false}));

const users = new Map();
const connections = [];
const rooms = new Map();



app.post("/accounts/login", (req, res) => {

    const account = {
        password :req.body.password,
        email: req.body.email
    }

    const session = mysqlx.getSession(connection)
        .then(session => {

            let db = session.getSchema("comchat");
            let accounts = db.getTable("accounts");

            accounts.select(["password", "email", "account_id", "username", "firstname", "lastname"])
            .where("email = :param")
            .bind("param", account.email)
            .execute()
            .then(data => {
                const user = data.fetchAll()[0];
                if (!user) res.send("No data found")
                else {
                        const setPassword = user[0];
                        
                        
                        if (account.password === setPassword) {

                            const acc = {
                                email : user[1],
                                id : user[2],
                                username : user[3],
                                firstname : user[4],
                                lastname : user[5]
                            }
        
                            res.send(JSON.stringify(acc));
                        } else res.send("Wrong password")
                }

            });

            session.close();
        })
        .catch(error => {
            console.log(error)
        });


});

app.post("/accounts/register", (req, res) => {
    const username = req.body.username;
    const email = req.body.email;
    const password = req.body.password;


    if (users.has(email)){
        res.send("An account under this email already exists!")
    } else {
    const session = mysqlx.getSession({user : "root", password : "dream", port : 1721})
        .then(session => {

            const db = session.getSchema("comchat");
            const accounts = db.getTable("accounts");

            accounts.insert(["username", "password", "email"])
            .values(username, password, email)
            .execute();

            res.send("success")
            users.set(email, true);
            session.close();
        })
        .catch(error => {throw new Error(error)});
    }


})


app.put("/accounts/update/profile/:id", (req, res) => {

    const id = req.params.id;
    const firstname = req.body.firstname;
    const lastname = req.body.lastname;
    const oldPassword = req.body.oldPassword;
    const newPassword = req.body.newPassword;
    let setPassword;

    function updateInformation() {
        const session = mysqlx.getSession(connection)
        .then(session => {
            const db = session.getSchema("comchat");
            const accounts = db.getTable("accounts");

            if (newPassword && !firstname && !lastname) {
                accounts.update()
                .set("password", newPassword)
                .where("account_id = :param")
                .bind("param", id)
                .execute()
                .then(()=> {
                    res.send("changed")
                })
            }

            if (firstname && lastname){
                accounts.update()
                .set("firstname", firstname)
                .set("lastname", lastname)
                .set("password", newPassword || setPassword)
                .where("account_id = :param")
                .bind("param", id)
                .execute()
                .then(()=> {
                    res.send("changed")
                })
            }

        });
    }

    if (id){

        const session = mysqlx.getSession(connection)
        .then(session => {
            const db = session.getSchema("comchat");
            const accounts = db.getTable("accounts");

            accounts.select(["password", "account_id"])
            .where("account_id  = :param")
            .bind("param", id)
            .execute()
            .then(resp => {
                resp = resp.fetchAll();
                const data = resp[0];
                if (data){
                    setPassword = data[0];

                    // check if old password word matches the set password
    
                   if (newPassword){
                        if (oldPassword === setPassword){
                            return updateInformation();
                        } else {
                            res.send("Wrong password")
                        } 
                   } else if(!oldPassword && !newPassword){
                        return updateInformation();
                    }
                } else {
                    res.send(null)
                }
            })


        })
        .catch(error => {
            throw new Error(error);
        })
    }
});

app.get("/:id/app/room/:room", (req, res) => {
    const roomName = req.params.room;
    const id = req.params.id;
    
    if (id){
        if (rooms.has(roomName)){
            const currentGroup = rooms.get(roomName);

            res.send(JSON.stringify({
                role : "member",
                group : roomName,
                admin : currentGroup.admin
                
            }))
        } else {
            
            rooms.set(roomName, {
                admin : id,
                group : roomName,
                members : []
            });

            res.send(JSON.stringify({
                role : "admin",
                group : roomName,
                admin : id
            }));
    
        }
    }

});


io.on("connection", socket => {

    connections.push(socket);

    socket.on("disconnecting", () => {
        const user = socket.username;
        const rm = socket.room; 

        if (rm){
            const members = rooms.get(rm).members;

            if (members.includes(user)){
                const i = members.indexOf(user);
                members.splice(i, 1);
                connections.splice(connections.indexOf(socket), 1);
                socket.to(rm).emit("members", rm.members);
            } else return;
        }

        return;
    })

    socket.on("username", username => {
        if (connections.includes(socket)){
            if (!socket.username){
                socket.username = username;
            }
        } else return;
    });

    socket.on("join", roomName => {
        if (rooms.get(roomName)){
                const room = rooms.get(roomName);
                room.members.push(socket.username);
                socket.join(roomName);
                socket.room = roomName;
                socket.to(roomName).emit("members", room.members);
        } 
    });

    socket.on("leave", action => {
        if (socket.room){
            if (action === "permanent"){
                const room = socket.room;
                const username = socket.username;
    
                if(rooms.get(room).members.includes(username)){
                    const roomMembers = rooms.get(room).members;
                    const index = roomMembers.indexOf(username);
                    roomMembers.splice(index, 1);
                    connections.splice(connections.indexOf(socket), 1);
                    console.log(socket.username + " left the room " + room);

                    if (rooms.get(room).members.length === 0){
                        rooms.delete(room);
                    }
                    
                    return socket.to(room).emit("members", roomMembers);
                } else return;
            }
        }
    });

    socket.on("getMembers", room => {
        room = rooms.get(room);
        if (room){
            return socket.emit("members", room.members);
        }
    })

    socket.on("message", message => {
        const room = socket.room;
        const username = socket.username;

        if (room && username){
            const i = connections.indexOf(socket)
            connections[i].to(room).emit("new-message", {sent : username, message});
        }
    });


});


server.listen(5000, () => console.log("Accounts service running at port 5000"));